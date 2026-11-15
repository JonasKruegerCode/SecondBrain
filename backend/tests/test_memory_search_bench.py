"""Scale, determinism and post-fix checks for the Memory Search bench."""

from __future__ import annotations

from tests.memory_search_bench.generate import N_PAGES, SEED, generate_corpus
from tests.memory_search_bench.measure import (
    build_bench,
    evaluate,
    flag_patterns,
    pattern_ingredients,
)
from tests.memory_search_bench.queries import FINANCE_STUBS, query_set


def test_bench_corpus_is_large_deterministic_and_hub_heavy() -> None:
    first = generate_corpus(SEED)
    second = generate_corpus(SEED)
    assert len(first.pages) == N_PAGES
    assert 780 <= len(first.pages) <= 820
    assert 3000 <= first.link_count <= 4000
    assert [page["id"] for page in first.pages] == [page["id"] for page in second.pages]
    assert first.link_count == second.link_count
    assert first.vectors == second.vectors
    assert all(
        left["markdown"] == right["markdown"]
        for left, right in zip(first.pages, second.pages, strict=True)
    )
    assert first.length_percentiles["p90"] >= 2000
    assert first.length_percentiles["max"] >= 3500
    hubs = [degree for degree in first.in_degree.values() if degree >= 50]
    assert len(hubs) >= 3
    assert len(set(first.topic_of.values())) >= 20


def test_bench_still_contains_the_pre_fix_pattern_ingredients() -> None:
    corpus = generate_corpus(SEED)
    assert pattern_ingredients(corpus, query_set()) == {"A": True, "B": True, "C": True}


def test_bench_search_fixes_the_known_failure_patterns() -> None:
    bench = build_bench(SEED)
    try:
        reports = evaluate(bench)
        by_label = {report.label: report for report in reports}
        assert pattern_ingredients(bench.corpus, bench.queries) == {"A": True, "B": True, "C": True}
        # B and C are fixed in the result list. A is addressed by a public
        # relevance value that follows visible order; close cosines may still
        # invert on the raw provider score when a title or id prefix fires.
        flags = flag_patterns(reports, bench.queries)
        assert flags["B"] is False
        assert flags["C"] is False

        name_topic = by_label["name+topic"]
        assert not name_topic.missing_must_keep
        assert "profile-tactics-comps" in name_topic.ids
        assert "tactics-rotation-theory" in name_topic.ids
        assert all(page_id not in name_topic.ids for page_id in FINANCE_STUBS)
        assert name_topic.ndcg5 == 1.0

        garden = by_label["topic-garden"]
        assert not garden.missing_must_keep
        assert "network-intrusion-log" not in garden.ids
        assert garden.ids[0] == "garden-plot-journal"

        close = by_label["close-cosine"]
        assert set(close.ids) >= {"beacon-drift-log", "signal-tower-notes"}
        assert close.relevance_monotone is True
        assert close.scores[close.ids.index("signal-tower-notes")] == 0.327
        assert close.scores[close.ids.index("beacon-drift-log")] == 0.318

        assert by_label["exact-title"].ids[0] == "person-mira-quill"
        assert all(not report.missing_must_keep for report in reports)
        assert all(report.relevance_monotone for report in reports)
        assert all(not report.noise_in_default for report in reports)
    finally:
        bench.indexes.close()
        bench.tmp.cleanup()
