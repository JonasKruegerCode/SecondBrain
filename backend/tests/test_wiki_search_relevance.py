"""Offline relevance of hybrid wiki search. No network and no model provider."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path
from typing import Any

from qdrant_client import QdrantClient

from second_brain.wiki.index_adapters import QdrantSnapshotAdapter
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.relevance import (
    adaptive_cutoff,
    content_tokens,
    drop_lexical_gap_tail,
    rank_pages,
)
from second_brain.wiki.search_service import search_wiki as run_wiki_search
from second_brain.wiki.store import WikiStore

PAGES: dict[str, str] = {
    "pulse-canonical-policy": """---
type: topic
status: current
---
# Pulse – canonical policy

This page is the only current canonical pulse policy.
A pulse is an autonomous cycle with explicit release.
""",
    "integrationtest-case-18-pulse-timer": """# Integration test case 18 – pulse timer

Case 18 validates the pulse timer. Pulse pulse pulse pulse.
Historical test material, not policy.
""",
    "topic-pulse-loop": """# Historical note: pulse loop

Older label for autonomous cycles. The definition lives on the pulse policy page.
""",
    "pulse-sensor-sketch": """---
type: archive
status: historical
---
# Archive sketch: pulse sensor

Older pulse-sensor sketch. Not current operation.
""",
    "pulse-reflection-site-survey": """---
type: archive
status: historical
---
# Historical pulse reflection

Preserves an old pulse journal entry.
""",
    "roadmap-merge-effects": """# Roadmap merge effects

Plan for a phased roll-out after a merge. Not about pulse policy.
""",
    "person-mira-quill": """---
type: person
---
# Mira Quill

Mira Quill is the central fictional persona in this eval vault.
Mira Mira Mira — primary knowledge hub for questions about Mira.

## Interests and leisure

Mira enjoys auto-battler strategy games and a companion tactics title in prose here.
See profile-tactics-comps for comp preferences.
""",
    "person-mira-bio": """# Bio record (secondary)

Secondary biographical stub for the vault. Mentions the persona only briefly.
""",
    "mira-writing-style": """# Mira's professional writing style

Fictional preferences for short posts and header images.
""",
    "mentor-of-mira": """# Mentor of Mira Quill

Fictional senior advisor to Mira Quill.
""",
    "profile-tactics-comps": """# Tactics comp profile

Team tactics profile and ranked-mode experience (fictional).
""",
    "bot-archivus": """---
type: person
---
# Archivus

Archivus is a fictional assistant bot. For “Archivus status?” the compact
orientation hub.
""",
    "vault-navigation-vision": """# Vault navigation vision

Fiction project page: wiki navigation, semantic search, star map and MCP.
""",
    "daily-chance-note": """# Daily chance note

Nobody knows what a day brings. Not a person article.
""",
    "star-map": """# Star map

The star map shows the wiki as constellations with groups and links.
""",
    "star-map-archive": """---
type: archive
status: historical
---
# Historical star-map log

Old export, not the current view.
""",
    "nebula-mention": """# Nebula

Mentions the star map only in passing.
""",
}

JUDGMENTS: dict[str, dict[str, int]] = {
    "pulse": {"pulse-canonical-policy": 3},
    "Was weiß Mira so": {
        "person-mira-quill": 3,
        "person-mira-bio": 2,
        "mira-writing-style": 1,
    },
    "Mira gaming": {
        "person-mira-quill": 3,
        "profile-tactics-comps": 2,
    },
    "Welche Projekte hat Mira": {
        "person-mira-quill": 3,
        "vault-navigation-vision": 2,
    },
    "Archivus status": {"bot-archivus": 3},
    "Star map": {"star-map": 3},
}

FLAT_PULSE: dict[str, float] = {
    "integrationtest-case-18-pulse-timer": 0.393,
    "topic-pulse-loop": 0.339,
    "pulse-canonical-policy": 0.330,
    "roadmap-merge-effects": 0.309,
    "pulse-reflection-site-survey": 0.305,
    "pulse-sensor-sketch": 0.297,
}


def _pages() -> list[dict[str, Any]]:
    rows = []
    for page_id, markdown in PAGES.items():
        title = next(
            (line[2:].strip() for line in markdown.splitlines() if line.startswith("# ")),
            page_id,
        )
        rows.append({"id": page_id, "title": title, "markdown": markdown})
    return rows


def _dcg(gains: list[float], k: int) -> float:
    return sum(gain / math.log2(index + 2) for index, gain in enumerate(gains[:k]))


def _ndcg(ranked: list[str], gains: dict[str, int], k: int = 5) -> float:
    ideal = _dcg(sorted((float(value) for value in gains.values()), reverse=True), k)
    actual = _dcg([float(gains.get(page_id, 0)) for page_id in ranked], k)
    return 1.0 if ideal == 0 else actual / ideal


def _mrr(ranked: list[str], relevant: set[str]) -> float:
    for index, page_id in enumerate(ranked, start=1):
        if page_id in relevant:
            return 1.0 / index
    return 0.0


class HashEmbedder:
    """Deterministic bag-of-tokens vectors. No network and no provider SDK."""

    def embed(self, text: str) -> list[float]:
        vector = [0.0] * 32
        tokens = content_tokens(text) or ["empty"]
        for token in tokens:
            bucket = int(hashlib.sha256(token.encode()).hexdigest()[:8], 16) % 32
            vector[bucket] += 1.0
        norm = math.sqrt(sum(value * value for value in vector)) or 1.0
        return [value / norm for value in vector]


def test_lexical_name_plus_topic_finds_body_without_literal_topic_word(
    tmp_path: Path,
) -> None:
    store = WikiStore(tmp_path)
    store.save_page("person-mira-quill", PAGES["person-mira-quill"], None, "seed")
    store.save_page("bot-archivus", "# Archivus\nUnrelated decoy mention.", None, "seed2")
    hits = store.search("Mira gaming", limit=10)
    assert hits
    assert hits[0]["id"] == "person-mira-quill"
    assert "rank_score" not in hits[0]


def test_question_words_do_not_erase_the_subject() -> None:
    assert content_tokens("Was weiß Mira so") == ["mira"]
    assert content_tokens("Mira gaming") == ["mira", "gaming"]


def test_lexical_gap_tail_drops_vector_neighbors_for_rare_anchor_tokens() -> None:
    pages = [
        *(_pages()),
        {
            "id": "queued-fixture",
            "title": "Queued fixture",
            "markdown": "# Queued fixture\nqueued-abcdef123456\n",
        },
    ]
    term = "queued-abcdef123456"
    ranked = rank_pages(term, pages, {str(page["id"]): 0.9 for page in pages})
    pruned = drop_lexical_gap_tail(term, pages, ranked)
    assert [page["id"] for page in pruned] == ["queued-fixture"]
    assert drop_lexical_gap_tail("Mira gaming", pages, ranked) == ranked


def test_flat_vector_scores_no_longer_outrank_the_canonical_page() -> None:
    pages = [page for page in _pages() if page["id"] in FLAT_PULSE]
    before = sorted(pages, key=lambda page: -FLAT_PULSE[str(page["id"])])
    assert before[0]["id"] == "integrationtest-case-18-pulse-timer"
    ranked = rank_pages("pulse", pages, FLAT_PULSE)
    kept = adaptive_cutoff(ranked, cap=15)
    assert kept[0]["id"] == "pulse-canonical-policy"
    assert _mrr([str(page["id"]) for page in kept], {"pulse-canonical-policy"}) == 1.0


def test_hybrid_search_metrics_and_cutoff_without_network(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for page_id, markdown in PAGES.items():
        store.save_page(page_id, markdown, None, page_id)
    client = QdrantClient(":memory:")
    indexes = IndexCoordinator(
        store, {"vector": QdrantSnapshotAdapter(client, HashEmbedder(), 32)}
    )
    try:
        assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
        reciprocal: list[float] = []
        discounted: list[float] = []
        for query, gains in JUDGMENTS.items():
            ranked = run_wiki_search(store, indexes, query)
            ids = [str(hit["id"]) for hit in ranked["results"]]
            canonical = next(page_id for page_id, gain in gains.items() if gain == 3)
            assert ids[0] == canonical, query
            assert all("rank_score" not in hit for hit in ranked["results"])
            reciprocal.append(_mrr(ids, {canonical}))
            discounted.append(_ndcg(ids, gains))
            explicit = run_wiki_search(store, indexes, query, limit=15)
            assert "cutoff" not in explicit
            assert explicit["results"][0]["id"] == canonical
        mrr = sum(reciprocal) / len(reciprocal)
        ndcg = sum(discounted) / len(discounted)
        assert mrr == 1.0
        assert ndcg >= 0.85
    finally:
        indexes.close()
        client.close()


def test_whitespace_query_returns_empty_results(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("home", "# Home\nFixture.", None, "seed")
    indexes = IndexCoordinator(store)
    try:
        for query in ("", "   ", "\n"):
            payload = run_wiki_search(store, indexes, query)
            assert payload["results"] == []
            assert "cutoff" not in payload
    finally:
        indexes.close()


def test_naive_vector_order_baseline_is_weaker(tmp_path: Path) -> None:
    """Document the before: pure cosine top-1 MRR on the fixture queries."""
    store = WikiStore(tmp_path)
    for page_id, markdown in PAGES.items():
        store.save_page(page_id, markdown, None, page_id)
    client = QdrantClient(":memory:")
    indexes = IndexCoordinator(
        store, {"vector": QdrantSnapshotAdapter(client, HashEmbedder(), 32)}
    )
    try:
        assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
        receipt = indexes._receipt("vector")
        assert receipt
        adapter = indexes.adapters["vector"]
        scores: list[float] = []
        for query, gains in JUDGMENTS.items():
            canonical = next(page_id for page_id, gain in gains.items() if gain == 3)
            hits = adapter.search(receipt["generation"], query, limit=5)
            ids = [str(hit["id"]) for hit in hits]
            scores.append(_mrr(ids, {canonical}))
        # Weaker than the hybrid path: at least one query misses the canonical page.
        assert sum(scores) / len(scores) < 1.0
    finally:
        indexes.close()
        client.close()
