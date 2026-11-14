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
    exclusive_token_restriction,
    rank_pages,
)
from second_brain.wiki.search_service import search_wiki as run_wiki_search
from second_brain.wiki.store import WikiStore

PAGES: dict[str, str] = {
    "heartbeat-richtlinie": """---
type: topic
status: current
---
# Heartbeat – kanonische Richtlinie

Diese Seite ist die einzige aktuelle kanonische Heartbeat-Richtlinie.
Ein Heartbeat ist ein autonomer Zyklus mit klarer Freigabe.
""",
    "integrationstest-tc-18-heartbeat-timer": """# Integrationstest TC-18 – Heartbeat-Timer

TC-18 validiert den Heartbeat-Timer. Heartbeat Heartbeat Heartbeat Heartbeat.
Der Test ist historisch und keine Richtlinie.
""",
    "topic-heartbeat-loop": """# Historischer Verweis: Heartbeat-Loop

Historische Bezeichnung für autonome Zyklen. Die maßgebliche Definition steht
auf der Heartbeat-Richtlinie.
""",
    "heartbeat-sensor-python": """---
type: archive
status: historical
---
# Historische Skizze: Heartbeat-Sensor

Ältere Skizze eines Heartbeat-Sensors. Kein aktueller Betrieb.
""",
    "heartbeat-reflexion-standortbestimmung": """---
type: archive
status: historical
---
# Historische Heartbeat-Reflexion

Bewahrt einen alten Heartbeat-Eintrag.
""",
    "roadmap-merge-auswirkungen": """# Roadmap Merge Auswirkungen

Ein Plan für ein schrittweises Roll-out nach einem Merge. Kein Heartbeat.
""",
    "person-jonas": """---
type: person
---
# Jonas

Jonas ist die zentrale Bezugsperson dieses SecondBrains.

## Interessen und Freizeit

In der Freizeit spielt Jonas League of Legends sowie Teamfight Tactics (TFT).
Das tft-spielprofil hält Comp-Vorlieben fest.
""",
    "person-jonas-krueger": """# Jonas Krüger – Stammdaten

Jonas Krüger ist der Nutzer und Eigentümer. Biografische Stammdaten.
""",
    "jonas-linkedin-schreibstil": """# Jonas' LinkedIn-Schreibstil

Präferenzen von Jonas für LinkedIn-Texte und Beitragsbilder.
""",
    "vater-von-jonas": """# Vater von Jonas Krüger

Vater von Jonas Krüger, erfahrener IT-Berater.
""",
    "tft-spielprofil": """# TFT-Spielprofil

Teamfight Tactics Spielprofil und League of Legends Erfahrung.
""",
    "person-jarvis": """---
type: person
---
# Jarvis

Jarvis ist der persönliche KI-Assistent. Für „Jarvis, Status?“ der kompakte
Orientierungsstand und Persönlichkeits-Hub.
""",
    "secondbrain-20-zielbild": """# SecondBrain 2.0 – Zielbild

Projektseite: Wiki-Navigation, semantische Suche, Galaxy und MCP.
""",
    "zufallsnotiz": """# Tagesnotiz

Was so ein Tag bringt, weiß niemand. Kein Personenartikel.
""",
    "galaxy": """# Galaxy

Die Galaxy zeigt das Wiki als Sternenkarte mit Gruppen und Links.
""",
    "galaxy-archiv": """---
type: archive
status: historical
---
# Historisches Galaxy-Log

Alter Export der Galaxy, nicht die aktuelle Ansicht.
""",
    "nebula-notiz": """# Nebel

Erwähnt die Galaxy nur am Rande einer anderen Beobachtung.
""",
}

JUDGMENTS: dict[str, dict[str, int]] = {
    "heartbeat": {"heartbeat-richtlinie": 3},
    "Was weiß Jonas so": {
        "person-jonas": 3,
        "person-jonas-krueger": 2,
        "jonas-linkedin-schreibstil": 1,
    },
    "Jonas Gaming": {
        "person-jonas": 3,
        "tft-spielprofil": 2,
    },
    "Welche Projekte hat Jonas": {
        "person-jonas": 3,
        "secondbrain-20-zielbild": 2,
    },
    "Jarvis Status": {"person-jarvis": 3},
    "Galaxy": {"galaxy": 3},
}

FLAT_HEARTBEAT: dict[str, float] = {
    "integrationstest-tc-18-heartbeat-timer": 0.393,
    "topic-heartbeat-loop": 0.339,
    "heartbeat-richtlinie": 0.330,
    "roadmap-merge-auswirkungen": 0.309,
    "heartbeat-reflexion-standortbestimmung": 0.305,
    "heartbeat-sensor-python": 0.297,
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


def test_lexical_jonas_gaming_finds_gaming_section_without_literal_gaming_word(
    tmp_path: Path,
) -> None:
    store = WikiStore(tmp_path)
    store.save_page("person-jonas", PAGES["person-jonas"], None, "seed")
    store.save_page("person-jarvis", "# Jarvis\nJonas Gaming mention only.", None, "seed2")
    hits = store.search("Jonas Gaming", limit=10)
    assert hits
    assert hits[0]["id"] == "person-jonas"


def test_question_words_do_not_erase_the_subject() -> None:
    assert content_tokens("Was weiß Jonas so") == ["jonas"]
    assert content_tokens("Jonas Gaming") == ["jonas", "gaming"]


def test_exclusive_uuid_tokens_suppress_vector_fixture_neighbors() -> None:
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
    restricted = exclusive_token_restriction(term, pages, ranked)
    assert [page["id"] for page in restricted] == ["queued-fixture"]
    assert exclusive_token_restriction("Jonas Gaming", pages, ranked) == ranked


def test_flat_vector_scores_no_longer_outrank_the_canonical_page() -> None:
    pages = [page for page in _pages() if page["id"] in FLAT_HEARTBEAT]
    before = sorted(pages, key=lambda page: -FLAT_HEARTBEAT[str(page["id"])])
    assert before[0]["id"] == "integrationstest-tc-18-heartbeat-timer"
    ranked = rank_pages("heartbeat", pages, FLAT_HEARTBEAT)
    kept = adaptive_cutoff(ranked, cap=15)
    assert kept[0]["id"] == "heartbeat-richtlinie"
    assert _mrr([str(page["id"]) for page in kept], {"heartbeat-richtlinie"}) == 1.0


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
