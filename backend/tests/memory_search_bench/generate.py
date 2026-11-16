"""Deterministic, anonymous synthetic wiki for the Memory Search bench.

The corpus is generated at test/measure time and never checked in. It is large
enough to expose the same ranking shapes as a real ~800 page wiki: a heavy-tailed
link graph, a mix of stub/note/article lengths, several dominant identity hubs,
and a wide range of topics. Fictional names only; no live wiki text, no network
and no provider SDK.

Vectors are a deterministic, network-free signal derived from topic assignments
(cluster centroids plus seeded noise), so BM25 and the field boosts still fire on
lexical-realistic text while semantic neighbours can be constructed on purpose.
"""

from __future__ import annotations

import math
import os
import random
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from second_brain.wiki.store import WikiStore

# Frozen seed: page ids, lengths, links, vectors and query labels are stable.
SEED = 20261115

TOPIC_SLUGS: tuple[str, ...] = (
    "harbor",
    "garden",
    "pulse",
    "tactics",
    "folio",
    "beacon",
    "lantern",
    "orchard",
    "quarry",
    "meridian",
    "grotto",
    "tempest",
    "cinder",
    "willow",
    "prism",
    "fathom",
    "tundra",
    "velvet",
    "zephyr",
    "ember",
    "solstice",
    "cobalt",
    "nimbus",
    "verdigris",
)

# Dominant identity hubs: (id, title, body name, share of pages that mention it).
IDENTITY_HUBS: tuple[tuple[str, str, str, float], ...] = (
    ("person-mira-quill", "Mira Quill", "Mira", 0.30),
    ("person-rowan-hale", "Rowan Hale", "Rowan", 0.12),
    ("bot-archivus", "Archivus", "Archivus", 0.08),
    ("person-corvus-vale", "Corvus Vale", "Corvus", 0.05),
    ("person-linnea-frost", "Linnea Frost", "Linnea", 0.04),
    ("person-bramwell-otis", "Bramwell Otis", "Bramwell", 0.03),
)

# Procedural filler used to grow the corpus beyond the named fixtures.
DESCRIPTORS: tuple[str, ...] = (
    "field",
    "ledger",
    "sketch",
    "survey",
    "digest",
    "outline",
    "log",
    "review",
    "draft",
    "index",
    "brief",
    "archive",
    "manifest",
    "primer",
    "notebook",
)
QUALIFIERS: tuple[str, ...] = (
    "north",
    "inner",
    "quiet",
    "long",
    "early",
    "upper",
    "lower",
    "far",
    "slow",
    "bright",
    "dense",
    "loose",
    "shared",
    "open",
    "hidden",
)
PROSE: tuple[str, ...] = (
    "The notes gather what the working group agreed on during the season.",
    "This entry keeps the durable record and the open questions in one place.",
    "Several small observations were folded in so the page still reads cleanly.",
    "The account is deliberately plain and avoids naming anything outside the set.",
    "Followers can trace the reasoning from the first draft to the final text.",
)

VECTOR_DIM = 32
# Enough seeded noise that same-topic cosines land in a realistic ~0.2 band,
# leaving room for controlled overrides above them.
VECTOR_NOISE = 2.0
N_PAGES = 800
LENGTH_TARGETS: dict[str, tuple[int, int]] = {
    "stub": (150, 300),
    "note": (600, 1200),
    "article": (2400, 4200),
}
LENGTH_WEIGHTS = (0.40, 0.45, 0.15)

# Explicit topics for the named fixtures. Identity hubs sit on a neutral
# centroid so they do not leak into a topic query.
FIXTURE_TOPICS: dict[str, str] = {
    "harbor-district-notes": "harbor",
    "garden-plot-journal": "garden",
    "soil-rotation-notes": "garden",
    "network-intrusion-log": "tempest",
    "pulse-canonical-policy": "pulse",
    "pulse-loop-history": "pulse",
    "beacon-drift-log": "beacon",
    "signal-tower-notes": "beacon",
    "verdigris-atlas": "verdigris",
    "profile-tactics-comps": "tactics",
    "tactics-rotation-theory": "tactics",
    "auto-battler-tactics-basics": "tactics",
    "ranked-tactics-notes": "tactics",
    "comp-counter-matrix": "tactics",
    "tempo-pivot-drills": "tactics",
    "mira-quill-ledger-notes": "folio",
    "mira-quill-invoice-log": "folio",
    "mira-quill-budget-draft": "folio",
    "mira-quill-expense-stub": "folio",
    "mira-quill-folio-balance": "folio",
    "mira-quill-payroll-sketch": "folio",
    "mira-quill-receipt-index": "folio",
    "mira-quill-audit-brief": "folio",
}
IDENTITY_TOPIC = "identity"


@dataclass
class Corpus:
    """Generated pages plus the metadata queries and the adapter need."""

    pages: list[dict[str, Any]]
    topic_of: dict[str, str]
    identities_of: dict[str, tuple[str, ...]]
    centroids: dict[str, list[float]]
    vectors: dict[str, list[float]]
    in_degree: dict[str, int]
    out_degree: dict[str, int]
    hub_ids: tuple[str, ...] = field(default=())
    link_count: int = 0
    length_percentiles: dict[str, int] = field(default_factory=dict)


def _unit(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


def _gaussian(rng: random.Random, dim: int = VECTOR_DIM) -> list[float]:
    return [rng.gauss(0.0, 1.0) for _ in range(dim)]


def _topic_weights() -> list[float]:
    # Zipf-like: the first topics dominate, the tail is thinly covered.
    return [1.0 / (index + 1) ** 0.9 for index in range(len(TOPIC_SLUGS))]


def _fixture_pages() -> list[dict[str, Any]]:
    """Hand-written named pages that anchor the failure patterns.

    Text stays lexical-realistic so BM25 and field boosts behave as in
    production, while each page pins the topic it should be retrieved under.
    """
    pages: list[dict[str, Any]] = []

    def add(page_id: str, title: str, body: str, links: tuple[str, ...] = ()) -> None:
        link_text = " ".join(f"[[{target}]]" for target in links)
        markdown = f"# {title}\n\n{body}\n\n{link_text}\n"
        pages.append({"id": page_id, "title": title, "markdown": markdown})

    add(
        "person-mira-quill",
        "Mira Quill",
        "Mira Quill is the central fictional persona of this synthetic vault. "
        "Mira keeps notes on tactics, folio ledgers and a garden log. "
        "The tactics comp profile lives beside this hub.",
        ("profile-tactics-comps", "harbor-district-notes"),
    )
    add(
        "harbor-district-notes",
        "Harbor district notes",
        "Harbor district notes. The harbor survey covers quays, tides and the harbor watch. "
        "A harbor record kept beside the garden allotment.",
        ("garden-plot-journal",),
    )
    add(
        "person-rowan-hale",
        "Rowan Hale",
        "Rowan Hale is a fictional archivist. Rowan files harbor surveys and garden notes.",
        ("harbor-district-notes",),
    )
    add(
        "bot-archivus",
        "Archivus",
        "Archivus is a fictional assistant bot. Ask Archivus for status and orientation.",
    )
    add(
        "person-corvus-vale",
        "Corvus Vale",
        "Corvus Vale is a fictional editor who reviews pulse reports.",
        ("pulse-canonical-policy",),
    )
    add(
        "person-linnea-frost",
        "Linnea Frost",
        "Linnea Frost is a fictional analyst of orchard and lantern records.",
    )
    add(
        "person-bramwell-otis",
        "Bramwell Otis",
        "Bramwell Otis is a fictional keeper of quarry manifests.",
    )

    # Tactics cluster: the rare, discriminative topic. Titles avoid a literal
    # "Tactics" prefix so the common identity token can dominate the old ranking.
    add(
        "profile-tactics-comps",
        "Comp rotation profile",
        "Team tactics profile and ranked-mode experience for a synthetic auto-battler hobby. "
        "Comp rotations, counter picks and tempo notes for tactics practice.",
        ("tactics-rotation-theory", "comp-counter-matrix"),
    )
    add(
        "tactics-rotation-theory",
        "Rotation theory notes",
        "Rotation theory for tactics boards: openings, pivots and endgame tempo.",
        ("comp-counter-matrix",),
    )
    add(
        "auto-battler-tactics-basics",
        "Auto-battler tactics basics",
        "A tactics primer for auto-battler boards. Position and economy notes.",
        ("tactics-rotation-theory",),
    )
    add(
        "ranked-tactics-notes",
        "Ranked tactics notes",
        "Ranked tactics notes for the synthetic hobby ladder. Tempo and counter play.",
    )
    add(
        "comp-counter-matrix",
        "Comp counter matrix",
        "A counter matrix for tactics comps. Which board beats which opener.",
        ("profile-tactics-comps",),
    )
    add(
        "tempo-pivot-drills",
        "Tempo pivot drills",
        "Tactics drills for tempo pivots. No literal tactics heading, still the same hobby.",
    )

    # Finance stubs: share the common identity token, not about tactics.
    finance = (
        ("mira-quill-ledger-notes", "Mira Quill ledger notes"),
        ("mira-quill-invoice-log", "Mira Quill invoice log"),
        ("mira-quill-budget-draft", "Mira Quill budget draft"),
        ("mira-quill-expense-stub", "Mira Quill expense stub"),
        ("mira-quill-folio-balance", "Mira Quill folio balance"),
        ("mira-quill-payroll-sketch", "Mira Quill payroll sketch"),
        ("mira-quill-receipt-index", "Mira Quill receipt index"),
        ("mira-quill-audit-brief", "Mira Quill audit brief"),
    )
    for page_id, title in finance:
        add(
            page_id,
            title,
            f"{title}: fictional bookkeeping notes for the vault. No hobby content.",
        )

    # Close-cosine inversion pair (pattern A): Beacon topic.
    add(
        "beacon-drift-log",
        "Beacon drift log",
        "A beacon drift log. The beacon signal drifts and the crew records every shift.",
        ("signal-tower-notes",),
    )
    add(
        "signal-tower-notes",
        "Signal tower notes",
        "Notes from the signal tower: the beacon burns all night over the shoals. "
        "No literal beacon heading, still the same topic.",
        ("beacon-drift-log",),
    )

    # Residual-noise cluster (pattern C): off-topic mid-cosine neighbour.
    add(
        "garden-plot-journal",
        "Garden plot journal",
        "The garden plot journal tracks beds, soil and the garden harvest across seasons.",
        ("soil-rotation-notes",),
    )
    add(
        "soil-rotation-notes",
        "Soil rotation notes",
        "Soil rotation and garden bed planning for the shared allotment. Garden notes only.",
        ("garden-plot-journal",),
    )
    add(
        "network-intrusion-log",
        "Network intrusion log",
        "A synthetic intrusion log for the perimeter. Firewall and packet notes. "
        "Not about gardens or beds.",
    )

    # Pulse near-match pair for the 0.875 ratio.
    add(
        "pulse-canonical-policy",
        "Pulse canonical policy",
        "The only current canonical pulse policy. A pulse is an autonomous cycle with release.",
        ("pulse-loop-history",),
    )
    add(
        "pulse-loop-history",
        "Pulse loop history",
        "Older pulse loop notes. The definition lives on the pulse policy page. Pulse cycles.",
        ("pulse-canonical-policy",),
    )

    # Unique rare term page.
    add(
        "verdigris-atlas",
        "Verdigris atlas",
        "The verdigris atlas charts a single rare colour set. Only this page carries verdigris.",
    )

    return pages


def _procedural_pages(rng: random.Random, reserved: set[str]) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    weights = _topic_weights()
    hub_titles = [(hub[0], hub[2], hub[3]) for hub in IDENTITY_HUBS]
    index = 0
    while len(reserved) < N_PAGES:
        topic = rng.choices(TOPIC_SLUGS, weights=weights, k=1)[0]
        descriptor = rng.choice(DESCRIPTORS)
        qualifier = rng.choice(QUALIFIERS)
        identity_token = ""
        for _hub_id, token, share in hub_titles:
            if rng.random() < share:
                identity_token = token
                break
        index += 1
        page_id = _page_id(
            topic, descriptor, qualifier, index, identity_token.casefold() or None
        )
        if page_id in reserved:
            continue
        title = f"{identity_token} {topic} {descriptor}".strip() if identity_token else (
            f"{topic} {descriptor}"
        )
        title = f"{qualifier.title()} {title}"
        reserved.add(page_id)
        pages.append({"id": page_id, "title": title, "markdown": ""})
    return pages


def _page_id(topic: str, descriptor: str, qualifier: str, index: int, identity: str | None) -> str:
    stem = f"{qualifier}-{topic}-{descriptor}-{index:03d}"
    return f"{identity}-{stem}" if identity else stem


def _paragraph(topic: str, identities: tuple[str, ...], rng: random.Random) -> str:
    words = list(PROSE)
    rng.shuffle(words)
    pieces = [words[0], f"The {topic} record stays in this topic.", words[1]]
    if identities:
        pieces.append(f"{identities[0]} reviewed the {topic} notes.")
    pieces.append(words[2])
    return " ".join(pieces)


def _fill_body(
    page: dict[str, Any],
    topic: str,
    identities: tuple[str, ...],
    rng: random.Random,
    length_class: str,
) -> None:
    low, high = LENGTH_TARGETS[length_class]
    target = rng.randint(low, high)
    title = page["title"]
    chunks = [f"# {title}", "", f"**Topic:** {topic}", ""]
    while sum(len(chunk) for chunk in chunks) < target:
        chunks.append(_paragraph(topic, identities, rng))
        chunks.append("")
        if length_class != "stub" and rng.random() < 0.3:
            chunks.append(f"## {topic.title()} detail {rng.randint(1, 9)}")
            chunks.append("")
    page["markdown"] = "\n".join(chunks)[: target + 400]


def _choose_targets(
    rng: random.Random,
    count: int,
    page_id: str,
    topic: str,
    topic_pool: dict[str, list[str]],
    hubs: tuple[str, ...],
    all_ids: list[str],
) -> list[str]:
    targets: list[str] = []
    seen: set[str] = set()
    while len(targets) < count:
        roll = rng.random()
        if roll < 0.32 and hubs:
            candidate = rng.choice(hubs)
        elif roll < 0.75 and topic_pool.get(topic):
            candidate = rng.choice(topic_pool[topic])
        else:
            candidate = rng.choice(all_ids)
        if candidate == page_id or candidate in seen:
            continue
        seen.add(candidate)
        targets.append(candidate)
    return targets


def _link_count(rng: random.Random) -> int:
    return max(1, min(12, int(rng.gauss(4.72, 1.7))))


def generate_corpus(seed: int = SEED) -> Corpus:
    """Build the full corpus deterministically for ``seed``."""
    rng = random.Random(seed)
    fixtures = _fixture_pages()
    fixture_ids = {page["id"] for page in fixtures}
    pages = fixtures + _procedural_pages(rng, set(fixture_ids))

    hub_ids = tuple(hub[0] for hub in IDENTITY_HUBS)
    hub_names = {hub[0]: hub[2] for hub in IDENTITY_HUBS}
    topic_of: dict[str, str] = {}
    identities_of: dict[str, tuple[str, ...]] = {}
    procedural_ids = {page["id"] for page in pages[len(fixtures) :]}
    for page in pages:
        page_id = page["id"]
        if page_id in procedural_ids:
            lowered = f"{page_id} {page['title']}".casefold()
            topic_of[page_id] = next((slug for slug in TOPIC_SLUGS if slug in lowered), "folio")
        else:
            topic_of[page_id] = FIXTURE_TOPICS.get(page_id, IDENTITY_TOPIC)
        lowered = f"{page_id} {page['title']}".casefold()
        identities_of[page_id] = tuple(
            hub_id for hub_id, name in hub_names.items() if name.casefold() in lowered
        )

    for page in pages[len(fixtures) :]:
        identities = identities_of[page["id"]]
        length_class = rng.choices(("stub", "note", "article"), weights=LENGTH_WEIGHTS, k=1)[0]
        _fill_body(page, topic_of[page["id"]], identities, rng, length_class)

    all_ids = [page["id"] for page in pages]
    topic_pool: dict[str, list[str]] = {slug: [] for slug in (*TOPIC_SLUGS, IDENTITY_TOPIC)}
    for page_id in all_ids:
        topic_pool[topic_of[page_id]].append(page_id)
    # Dominant hubs also receive many links.
    top_topics = sorted(topic_pool, key=lambda slug: len(topic_pool[slug]), reverse=True)[:3]
    link_hubs = hub_ids + tuple(topic_pool[slug][0] for slug in top_topics if topic_pool[slug])

    link_count = 0
    out_degree: dict[str, int] = {}
    in_degree: dict[str, int] = dict.fromkeys(all_ids, 0)
    for page in pages:
        page_id = page["id"]
        count = _link_count(rng)
        targets = _choose_targets(
            rng, count, page_id, topic_of[page_id], topic_pool, link_hubs, all_ids
        )
        for target in targets:
            in_degree[target] += 1
        link_count += len(targets)
        out_degree[page_id] = len(targets)
        page["markdown"] = page["markdown"].rstrip() + "\n\n" + " ".join(
            f"[[{target}]]" for target in targets
        ) + "\n"

    centroids = {slug: _unit(_gaussian(rng)) for slug in (*TOPIC_SLUGS, IDENTITY_TOPIC)}
    vectors: dict[str, list[float]] = {}
    for page in pages:
        page_id = page["id"]
        noise = _gaussian(rng)
        blended = [
            centroids[topic_of[page_id]][axis] + VECTOR_NOISE * noise[axis]
            for axis in range(VECTOR_DIM)
        ]
        vectors[page_id] = _unit(blended)

    lengths = sorted(len(page["markdown"]) for page in pages)
    percentiles = {
        name: lengths[min(len(lengths) - 1, int(fraction * len(lengths)))]
        for name, fraction in (("p50", 0.5), ("p90", 0.9), ("p99", 0.99), ("max", 0.999))
    }
    return Corpus(
        pages=pages,
        topic_of=topic_of,
        identities_of=identities_of,
        centroids=centroids,
        vectors=vectors,
        in_degree=in_degree,
        out_degree=out_degree,
        hub_ids=hub_ids,
        link_count=link_count,
        length_percentiles=percentiles,
    )


def seed_store(store: WikiStore, pages: list[dict[str, Any]]) -> None:
    """Write every page into the store's bare repo with one fast Git commit.

    ``WikiStore.save_page`` issues several subprocesses per page; 800 pages
    would take minutes. A temporary work tree plus a single commit keeps the
    bench in the seconds budget while still exercising the real read path.
    """
    work_tree = Path(store.path) / ".bench-worktree"
    pages_dir = work_tree / "pages"
    pages_dir.mkdir(parents=True, exist_ok=True)
    for page in pages:
        (pages_dir / f"{page['id']}.md").write_text(page["markdown"], encoding="utf-8")
    index_file = str(Path(store.path) / ".bench-index")
    env = {
        **os.environ,
        "GIT_INDEX_FILE": index_file,
        "GIT_AUTHOR_NAME": "Managed Wiki",
        "GIT_AUTHOR_EMAIL": "wiki@localhost",
        "GIT_COMMITTER_NAME": "Managed Wiki",
        "GIT_COMMITTER_EMAIL": "wiki@localhost",
    }
    common = ["git", "--git-dir", str(store.repo), "--work-tree", str(work_tree)]
    subprocess.run([*common, "add", "-A"], env=env, check=True, capture_output=True)
    subprocess.run(
        [*common, "commit", "-m", "bench seed"],
        env=env,
        check=True,
        capture_output=True,
    )
