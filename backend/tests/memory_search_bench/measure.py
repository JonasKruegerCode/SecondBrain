"""Run the Memory Search bench and print ranking, coherence and metrics.

Usage (post-fix tree):

    cd backend && .venv/bin/python -m tests.memory_search_bench.measure

``--baseline`` additionally flags the three pre-fix pattern conditions in the
observed results, so a future change can prove the generator still would have
exposed them against the old ranking.
"""

from __future__ import annotations

import argparse
import math
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore
from tests.memory_search_bench.generate import (
    SEED,
    Corpus,
    generate_corpus,
    seed_store,
)
from tests.memory_search_bench.queries import Query, query_set

RESULT_POOL = 15
# Default topic cosines are capped below the controlled pattern overrides so the
# hand-built pages always lead their query without pinning every page by hand.
DEFAULT_CAP = 0.25
# The near-match floor the bench was built to expose. Kept literal so the
# ingredient check stays valid after the production constant is tightened.
BASELINE_SEMANTIC_FLOOR = 0.85


class BenchStore(WikiStore):
    """WikiStore with a read-only snapshot cache; the bench never mutates it."""

    def __init__(self, path: str | Path) -> None:
        super().__init__(path)
        self._cached_snapshot: dict[str, Any] | None = None
        self._cached_head: str | None = None

    def snapshot(self) -> dict[str, Any]:
        if self._cached_snapshot is None:
            self._cached_snapshot = super().snapshot()
        return self._cached_snapshot

    def _head(self) -> str:
        if self._cached_head is None:
            self._cached_head = super()._head()
        return self._cached_head


class BenchVectorAdapter:
    """Deterministic per-query cosines from topic centroids plus overrides.

    The real provider is replaced by a network-free cosine: pages of the query's
    topic score high, overrides pin the hand-built pattern pages, and every id
    keeps a real revision so the coordinator's staleness checks behave normally.
    """

    def __init__(self, corpus: Corpus, queries: list[Query]) -> None:
        self.corpus = corpus
        self.query_vectors = {
            query.text: corpus.centroids[query.topic] for query in queries if query.topic
        }
        self.overrides = {query.text: dict(query.overrides) for query in queries}
        self.revisions: dict[str, str] = {}

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        self.revisions = {str(page["id"]): str(page["revision"]) for page in snapshot["pages"]}

    def _scores(self, query: str) -> dict[str, float]:
        scores: dict[str, float] = {}
        vector = self.query_vectors.get(query)
        if vector is not None:
            for page_id, page_vector in self.corpus.vectors.items():
                raw = sum(
                    left * right for left, right in zip(vector, page_vector, strict=True)
                )
                scores[page_id] = min(DEFAULT_CAP, max(0.0, raw))
        scores.update(self.overrides.get(query, {}))
        return scores

    def _hits(self, query: str, limit: int) -> list[dict[str, Any]]:
        hits = [
            {"id": page_id, "revision": self.revisions.get(page_id, ""), "score": score}
            for page_id, score in self._scores(query).items()
            if page_id in self.revisions and score > 0.0
        ]
        def _key(hit: dict[str, Any]) -> tuple[float, str]:
            raw = hit["score"]
            value = raw if isinstance(raw, (int, float)) else 0.0
            return (-float(value), str(hit["id"]))

        hits.sort(key=_key)
        return hits[:limit]

    def search(self, generation: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
        return self._hits(query, limit)

    def search_grouped(self, generation: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
        return self._hits(query, limit)


@dataclass
class Bench:
    corpus: Corpus
    store: WikiStore
    indexes: IndexCoordinator
    queries: list[Query]
    tmp: tempfile.TemporaryDirectory[str]


def build_bench(seed: int = SEED, root: str | Path | None = None) -> Bench:
    """Generate, seed and index the corpus with the real coordinator path."""
    corpus = generate_corpus(seed)
    tmp = tempfile.TemporaryDirectory(dir=str(root) if root else None)
    store = BenchStore(Path(tmp.name) / "vault")
    seed_store(store, corpus.pages)
    queries = query_set()
    adapter = BenchVectorAdapter(corpus, queries)
    indexes = IndexCoordinator(store, {"vector": adapter})
    state = indexes.run_once()["indexes"]["vector"]["state"]
    if state != "current":
        raise RuntimeError(f"bench vector index did not become current: {state}")
    return Bench(corpus=corpus, store=store, indexes=indexes, queries=queries, tmp=tmp)


def _dcg(gains: list[float], k: int) -> float:
    return sum(gain / math.log2(index + 2) for index, gain in enumerate(gains[:k]))


def _ndcg(ranked: list[str], gains: dict[str, int], k: int) -> float:
    ideal = _dcg(sorted((float(value) for value in gains.values()), reverse=True), k)
    actual = _dcg([float(gains.get(page_id, 0)) for page_id in ranked], k)
    return 1.0 if ideal == 0 else actual / ideal


def _mrr(ranked: list[str], relevant: set[str]) -> float:
    for index, page_id in enumerate(ranked, start=1):
        if page_id in relevant:
            return 1.0 / index
    return 0.0


def _monotone(values: list[float]) -> bool:
    return all(left >= right for left, right in zip(values, values[1:], strict=False))


@dataclass
class QueryReport:
    label: str
    ids: list[str]
    scores: list[float]
    gains: list[float]
    public_relevance: list[float]
    ndcg5: float
    ndcg10: float
    mrr: float
    missing_must_keep: list[str]
    noise_in_default: list[str]
    score_monotone: bool
    relevance_monotone: bool | None


def evaluate(bench: Bench) -> list[QueryReport]:
    reports: list[QueryReport] = []
    for query in bench.queries:
        payload = bench.indexes.semantic_search(query.text, None)
        results = payload["results"]
        ids = [str(hit["id"]) for hit in results]
        scores = [float(hit.get("score") or 0.0) for hit in results]
        gains = [float(query.relevance.get(page_id, 0)) for page_id in ids]
        public = [hit.get("relevance") for hit in results]
        public_relevance = (
            [float(value) for value in public]
            if results and all(value is not None for value in public)
            else []
        )
        relevant = {page_id for page_id, gain in query.relevance.items() if gain > 0}
        must_keep = set(query.must_keep) or relevant
        reports.append(
            QueryReport(
                label=query.label,
                ids=ids,
                scores=scores,
                gains=gains,
                public_relevance=public_relevance,
                ndcg5=_ndcg(ids, query.relevance, 5),
                ndcg10=_ndcg(ids, query.relevance, 10),
                mrr=_mrr(ids, relevant),
                missing_must_keep=sorted(must_keep.difference(ids)),
                noise_in_default=[page_id for page_id in query.noise if page_id in ids],
                score_monotone=_monotone(scores),
                relevance_monotone=_monotone(public_relevance) if public_relevance else None,
            )
        )
    return reports


def graph_stats(snapshot: dict[str, Any]) -> tuple[int, dict[str, int]]:
    in_degree: dict[str, int] = {str(page["id"]): 0 for page in snapshot["pages"]}
    for edge in snapshot["graph"]["edges"]:
        target = str(edge["target"])
        if target in in_degree:
            in_degree[target] += 1
    return len(snapshot["graph"]["edges"]), in_degree


def pattern_ingredients(corpus: Corpus, queries: list[Query]) -> dict[str, bool]:
    """Flag whether the seeded corpus still contains each pattern's ingredients.

    This is code-independent: it checks the controlled cosines and the lexical
    shape, not the current ranking. Future work can run it to confirm the bench
    would still expose the pre-fix bugs.
    """
    close = any(query.pattern == "A" for query in queries)
    common_and_rare = any(query.pattern == "B" for query in queries)
    noise = any(
        query.pattern == "C"
        and query.noise
        and any(
            query.overrides.get(leader, 0.0) >= 0.15
            and query.overrides.get(page_id, 0.0) / max(query.overrides.get(leader, 1.0), 1e-9)
            >= BASELINE_SEMANTIC_FLOOR * 0.999
            and query.overrides.get(page_id, 0.0)
            / max(query.overrides.get(leader, 1.0), 1e-9)
            < 0.87
            for leader in query.must_keep
            for page_id in query.noise
        )
        for query in queries
    )
    return {"A": close, "B": common_and_rare, "C": noise}


def flag_patterns(reports: list[QueryReport], queries: list[Query]) -> dict[str, bool]:
    """Flag the three pre-fix pattern conditions in observed results."""
    by_label = {report.label: report for report in reports}
    close = False
    for query in queries:
        if query.pattern != "A":
            continue
        report = by_label[query.label]
        if not report.score_monotone:
            close = True

    common = False
    for query in queries:
        if query.pattern != "B" or not query.noise:
            continue
        report = by_label[query.label]
        positions = {page_id: index for index, page_id in enumerate(report.ids)}
        core = [page_id for page_id in query.must_keep if page_id in positions]
        if not core:
            core = [
                page_id
                for page_id, gain in query.relevance.items()
                if gain >= 2 and page_id in positions
            ]
        if not core:
            continue
        core_positions = [positions[page_id] for page_id in core]
        noise_positions = [
            positions[page_id] for page_id in query.noise if page_id in positions
        ]
        # The pre-fix shape: a common-token stub outranks a rare-topic page.
        if noise_positions and min(noise_positions) < max(core_positions):
            common = True

    residual = any(by_label[query.label].noise_in_default for query in queries if query.noise)
    return {"A": close, "B": common, "C": residual}


def _print_stats(bench: Bench) -> None:
    snapshot = bench.store.snapshot()
    edge_count, in_degree = graph_stats(snapshot)
    hubs = sorted(in_degree.items(), key=lambda item: (-item[1], item[0]))[:5]
    lengths = sorted(len(page["markdown"]) for page in snapshot["pages"])
    percentiles = {name: lengths[min(len(lengths) - 1, int(fraction * len(lengths)))]
                   for name, fraction in (("p50", 0.5), ("p90", 0.9), ("p99", 0.99))}
    print("== corpus ==")
    topics = len(set(bench.corpus.topic_of.values()))
    print(f"pages={len(snapshot['pages'])} wikilinks={edge_count} topics={topics}")
    print(
        f"length p50={percentiles['p50']} p90={percentiles['p90']} "
        f"p99={percentiles['p99']} max={lengths[-1]}"
    )
    print("top hubs in-degree: " + ", ".join(f"{page_id}={degree}" for page_id, degree in hubs))


def _print_reports(reports: list[QueryReport]) -> None:
    print("== queries ==")
    for report in reports:
        line = (
            f"[{report.label}] nDCG@5={report.ndcg5:.3f} "
            f"nDCG@10={report.ndcg10:.3f} MRR={report.mrr:.3f}"
        )
        print(line)
        print(f"  ids={report.ids}")
        print(f"  scores={[round(score, 3) for score in report.scores]}")
        if report.public_relevance:
            print(f"  relevance={[round(value, 3) for value in report.public_relevance]}")
        print(
            f"  score_monotone={report.score_monotone} "
            f"relevance_monotone={report.relevance_monotone} "
            f"missing_must_keep={report.missing_must_keep} "
            f"noise_in_default={report.noise_in_default}"
        )


def _print_summary(reports: list[QueryReport]) -> None:
    count = len(reports) or 1
    checked = [r.relevance_monotone for r in reports if r.relevance_monotone is not None]
    print("== summary ==")
    print(f"mean nDCG@5={sum(r.ndcg5 for r in reports) / count:.3f}")
    print(f"mean nDCG@10={sum(r.ndcg10 for r in reports) / count:.3f}")
    print(f"mean MRR={sum(r.mrr for r in reports) / count:.3f}")
    print(f"score-monotone queries={sum(r.score_monotone for r in reports)}/{len(reports)}")
    print(
        "relevance-monotone queries="
        f"{sum(bool(value) for value in checked)}/{len(checked)}"
    )
    print(f"queries missing a must-keep page={sum(bool(r.missing_must_keep) for r in reports)}")
    print(f"queries with residual noise={sum(bool(r.noise_in_default) for r in reports)}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Memory Search bench.")
    parser.add_argument("--seed", type=int, default=SEED)
    parser.add_argument("--baseline", action="store_true", help="flag pre-fix pattern conditions")
    args = parser.parse_args()
    bench = build_bench(args.seed)
    try:
        reports = evaluate(bench)
        _print_stats(bench)
        _print_reports(reports)
        _print_summary(reports)
        print(f"pattern ingredients={pattern_ingredients(bench.corpus, bench.queries)}")
        if args.baseline:
            print(f"pattern flags={flag_patterns(reports, bench.queries)}")
    finally:
        bench.indexes.close()
        bench.tmp.cleanup()


if __name__ == "__main__":
    main()
