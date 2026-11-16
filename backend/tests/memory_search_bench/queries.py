"""Fixed synthetic queries, controlled cosines and graded relevance.

Every label, page id and query string here is fictional and belongs to the
generated bench corpus. The controlled cosines pin the semantic signal for the
handful of pages that anchor each failure pattern; everything else is derived
from the topic centroids in :mod:`tests.memory_search_bench.generate`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Finance stubs share the common identity token but are not about tactics.
FINANCE_STUBS: tuple[str, ...] = (
    "mira-quill-ledger-notes",
    "mira-quill-invoice-log",
    "mira-quill-budget-draft",
    "mira-quill-expense-stub",
    "mira-quill-folio-balance",
    "mira-quill-payroll-sketch",
    "mira-quill-receipt-index",
    "mira-quill-audit-brief",
)

TACTICS_PAGES: tuple[str, ...] = (
    "profile-tactics-comps",
    "tactics-rotation-theory",
    "auto-battler-tactics-basics",
    "ranked-tactics-notes",
    "comp-counter-matrix",
    "tempo-pivot-drills",
)


@dataclass
class Query:
    """One bench query with controlled cosine overrides and graded relevance."""

    label: str
    text: str
    topic: str | None = None
    overrides: dict[str, float] = field(default_factory=dict)
    relevance: dict[str, int] = field(default_factory=dict)
    pattern: str | None = None
    must_keep: tuple[str, ...] = ()
    noise: tuple[str, ...] = ()


def _overrides(*values: tuple[str, float]) -> dict[str, float]:
    return dict(values)


def query_set() -> list[Query]:
    """Return the fixed, deterministic query set (a dozen graded queries)."""
    finance_low = dict.fromkeys(FINANCE_STUBS, 0.2)
    tactics_scores = _overrides(
        ("person-mira-quill", 0.42),
        ("profile-tactics-comps", 0.38),
        ("tactics-rotation-theory", 0.36),
        ("auto-battler-tactics-basics", 0.35),
        ("ranked-tactics-notes", 0.34),
        ("comp-counter-matrix", 0.33),
        ("tempo-pivot-drills", 0.32),
    ) | finance_low
    return [
        Query(
            label="topic-harbor",
            text="harbor",
            topic="harbor",
            overrides=_overrides(("harbor-district-notes", 0.45)),
            relevance={
                "harbor-district-notes": 3,
                "person-rowan-hale": 1,
            },
            must_keep=("harbor-district-notes",),
        ),
        Query(
            label="topic-garden",
            text="garden",
            topic="garden",
            pattern="C",
            overrides=_overrides(
                ("garden-plot-journal", 0.42),
                ("soil-rotation-notes", 0.37),
                ("network-intrusion-log", 0.36),
            ),
            relevance={
                "garden-plot-journal": 3,
                "soil-rotation-notes": 2,
                "network-intrusion-log": 0,
            },
            must_keep=("garden-plot-journal", "soil-rotation-notes"),
            noise=("network-intrusion-log",),
        ),
        Query(
            label="topic-pulse",
            text="pulse",
            topic="pulse",
            overrides=_overrides(
                ("pulse-canonical-policy", 0.32),
                ("pulse-loop-history", 0.28),
            ),
            relevance={
                "pulse-canonical-policy": 3,
                "pulse-loop-history": 2,
                "person-corvus-vale": 1,
            },
            must_keep=("pulse-canonical-policy", "pulse-loop-history"),
        ),
        Query(
            label="topic-tactics",
            text="tactics",
            topic="tactics",
            overrides=_overrides(
                ("profile-tactics-comps", 0.45),
                ("tactics-rotation-theory", 0.42),
                ("auto-battler-tactics-basics", 0.40),
                ("ranked-tactics-notes", 0.38),
                ("comp-counter-matrix", 0.36),
                ("tempo-pivot-drills", 0.34),
            ),
            relevance={
                page_id: 3 if page_id == "profile-tactics-comps" else 2
                for page_id in TACTICS_PAGES
            },
            must_keep=("profile-tactics-comps",),
        ),
        Query(
            label="name+topic",
            text="Mira tactics",
            pattern="B",
            overrides=tactics_scores,
            relevance={
                "person-mira-quill": 2,
                **dict.fromkeys(TACTICS_PAGES, 2),
                **dict.fromkeys(FINANCE_STUBS, 0),
            },
            must_keep=("profile-tactics-comps", "tactics-rotation-theory"),
            noise=FINANCE_STUBS,
        ),
        Query(
            label="exact-title",
            text="Mira Quill",
            overrides=_overrides(("person-mira-quill", 0.45)),
            relevance={"person-mira-quill": 3},
            must_keep=("person-mira-quill",),
        ),
        Query(
            label="close-cosine",
            text="beacon",
            pattern="A",
            overrides=_overrides(
                ("signal-tower-notes", 0.327),
                ("beacon-drift-log", 0.318),
            ),
            relevance={
                "signal-tower-notes": 3,
                "beacon-drift-log": 2,
            },
            must_keep=("signal-tower-notes", "beacon-drift-log"),
        ),
        Query(
            label="rare-term",
            text="verdigris",
            topic="verdigris",
            overrides=_overrides(("verdigris-atlas", 0.45)),
            relevance={"verdigris-atlas": 3},
            must_keep=("verdigris-atlas",),
        ),
        Query(
            label="name+topic-2",
            text="Rowan Hale garden",
            overrides=_overrides(
                ("person-rowan-hale", 0.40),
                ("garden-plot-journal", 0.36),
                ("soil-rotation-notes", 0.35),
                ("network-intrusion-log", 0.06),
            ),
            relevance={
                "person-rowan-hale": 2,
                "garden-plot-journal": 3,
                "soil-rotation-notes": 2,
                "network-intrusion-log": 0,
            },
            must_keep=("garden-plot-journal", "soil-rotation-notes"),
            noise=("network-intrusion-log",),
        ),
        Query(
            label="exact-bot",
            text="Archivus status",
            overrides=_overrides(("bot-archivus", 0.44)),
            relevance={"bot-archivus": 3},
            must_keep=("bot-archivus",),
        ),
        Query(
            label="two-topics",
            text="orchard lantern",
            topic="orchard",
            overrides=_overrides(
                ("person-linnea-frost", 0.34),
            ),
            relevance={"person-linnea-frost": 2},
            must_keep=("person-linnea-frost",),
        ),
        Query(
            label="topic-folio",
            text="folio",
            topic="folio",
            overrides=_overrides(
                ("mira-quill-folio-balance", 0.40),
                ("mira-quill-ledger-notes", 0.35),
            ),
            relevance={
                "mira-quill-folio-balance": 3,
                "mira-quill-ledger-notes": 2,
            },
            must_keep=("mira-quill-folio-balance",),
        ),
    ]
