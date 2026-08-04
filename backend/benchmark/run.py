#!/usr/bin/env python3
"""
Ingestion Benchmark / Dry-Run Tool
===================================

Läuft nur gather + plan (kein apply), gibt einen Recall/Precision-Report aus
und speichert ihn persistent für Zeitreihen-Vergleiche.

Verwendung:
    python -m benchmark.run [--input benchmark/ground_truth.md] [--run-id myrun]

Optionen:
    --input FILE     Eingabedatei mit Fakten (default: benchmark/ground_truth.md)
    --run-id ID      Name für diesen Run (default: Zeitstempel)
    --output-dir DIR Verzeichnis für Report-JSON/-Markdown (default: benchmark/runs/)
    --no-split       Topic-Split überspringen, gesamte Datei als einen Block übergeben
    --verbose        Detailliertere Ausgabe
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# Ensure src is on the path when run as script
_SRC = Path(__file__).parent.parent / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from second_brain.agent.edit_vault import (  # noqa: E402
    EditVaultState,  # noqa: E402
    _plan,
    split_into_topics,
)
from second_brain.agent.operations import describe  # noqa: E402

# ---------------------------------------------------------------------------
# Ground-truth parsing
# ---------------------------------------------------------------------------

_FACT_RE = re.compile(r"^(F\d+):\s+(.+)$", re.MULTILINE)


def parse_ground_truth(text: str) -> dict[str, str]:
    """Returns {fact_id: fact_text} from the ground_truth.md format."""
    return {m.group(1): m.group(2).strip() for m in _FACT_RE.finditer(text)}


def extract_all_facts_text(path: Path) -> str:
    """Extracts only the fact lines (F01–FNN: ...) as plain text for ingestion."""
    content = path.read_text(encoding="utf-8")
    facts = _FACT_RE.findall(content)
    return "\n".join(f"{fid}: {text}" for fid, text in facts)


# ---------------------------------------------------------------------------
# Dry-run: plan only (gather skipped — no Qdrant needed for benchmark)
# ---------------------------------------------------------------------------

async def dry_run_topic(topic: str) -> dict[str, Any]:
    """Runs plan only (no gather) for one topic, returns raw plan data.

    gather is skipped intentionally: the benchmark measures LLM planning
    quality in isolation. Qdrant/Neo4j do not need to be running.
    """
    state: EditVaultState = {
        "mode": "remember",
        "focus": topic,
        "source": "benchmark",
        "pages": {},          # empty — no existing wiki context
        "operations": [],
        "rejected": [],
        "changed": {},
        "created": [],
        "deleted": [],
        "skipped": [],
        "applied": [],
        "needs_reconcile": False,
        "result": "no_changes",
    }
    state_after_plan = await _plan(state)
    ops = state_after_plan.get("operations", [])
    rejected = state_after_plan.get("rejected", [])
    return {
        "topic_preview": topic[:120],
        "pages_loaded": list(state["pages"].keys()),
        "operations": [describe(op) for op in ops],
        "op_types": [type(op).__name__ for op in ops],
        "rejected": rejected,
        "raw_ops": ops,
    }


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def _fact_mentioned(fact_text: str, op_descriptions: list[str]) -> bool:
    """Heuristic: check if key nouns/phrases from the fact appear in any op."""
    # Lowercase comparison; split into significant words (≥5 chars)
    words = [w.lower() for w in re.findall(r"\w+", fact_text) if len(w) >= 5]
    if not words:
        return False
    combined = " ".join(op_descriptions).lower()
    # A fact is "mentioned" if at least 40% of its significant words appear in the ops
    hits = sum(1 for w in words if w in combined)
    return hits / len(words) >= 0.4


def score(
    ground_truth: dict[str, str],
    all_op_descriptions: list[str],
    verbose: bool = False,
) -> dict[str, Any]:
    found: list[str] = []
    missing: list[str] = []
    for fid, ftext in ground_truth.items():
        if _fact_mentioned(ftext, all_op_descriptions):
            found.append(fid)
        else:
            missing.append(fid)

    recall = len(found) / len(ground_truth) if ground_truth else 0.0

    # Precision heuristic: ops that contain NONE of the ground-truth keywords
    # are flagged as potential hallucinations
    all_gt_words = {
        w.lower()
        for t in ground_truth.values()
        for w in re.findall(r"\w+", t)
        if len(w) >= 5
    }
    potential_hallucinations: list[str] = []
    for op_desc in all_op_descriptions:
        op_words = {w.lower() for w in re.findall(r"\w+", op_desc) if len(w) >= 5}
        if not op_words.intersection(all_gt_words):
            potential_hallucinations.append(op_desc)

    precision = (
        (len(all_op_descriptions) - len(potential_hallucinations)) / len(all_op_descriptions)
        if all_op_descriptions
        else 1.0
    )

    return {
        "total_facts": len(ground_truth),
        "found_facts": len(found),
        "missing_facts": len(missing),
        "recall": round(recall, 3),
        "total_ops": len(all_op_descriptions),
        "potential_hallucinations": len(potential_hallucinations),
        "precision": round(precision, 3),
        "found_ids": found,
        "missing_ids": missing,
        "hallucinated_ops": potential_hallucinations,
    }


# ---------------------------------------------------------------------------
# Report formatting
# ---------------------------------------------------------------------------

def format_report(
    run_id: str,
    ground_truth: dict[str, str],
    topic_results: list[dict[str, Any]],
    scores: dict[str, Any],
    elapsed_seconds: float,
    split_used: bool,
) -> str:
    all_op_types: dict[str, int] = {}
    for tr in topic_results:
        for ot in tr["op_types"]:
            all_op_types[ot] = all_op_types.get(ot, 0) + 1

    lines = [
        f"# Ingestion Benchmark Report — {run_id}",
        "",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"**Topic split:** {'yes' if split_used else 'no'}",
        f"**Topics processed:** {len(topic_results)}",
        f"**Elapsed:** {elapsed_seconds:.1f}s",
        "",
        "## Scores",
        "",
        "| Metric | Value |",
        "|--------|-------|",
        f"| Recall | {scores['recall']:.1%}"
        f" ({scores['found_facts']}/{scores['total_facts']} facts) |",
        f"| Precision | {scores['precision']:.1%}"
        f" ({scores['total_ops'] - scores['potential_hallucinations']}"
        f"/{scores['total_ops']} ops grounded) |",
        f"| Total ops | {scores['total_ops']} |",
        "",
        "## Op-Type Distribution",
        "",
    ]
    for ot, cnt in sorted(all_op_types.items(), key=lambda x: -x[1]):
        lines.append(f"- `{ot}`: {cnt}")
    lines += [
        "",
        "## Missing Facts (not captured)",
        "",
    ]
    for fid in scores["missing_ids"]:
        lines.append(f"- **{fid}**: {ground_truth.get(fid, '?')}")
    lines += [
        "",
        "## Potential Hallucinations (ops with no ground-truth keywords)",
        "",
    ]
    for op in scores["hallucinated_ops"]:
        lines.append(f"- {op}")
    if not scores["hallucinated_ops"]:
        lines.append("*(none detected)*")
    lines += ["", "## Per-Topic Details", ""]
    for i, tr in enumerate(topic_results, 1):
        lines.append(f"### Topic {i}: {tr['topic_preview'][:80]}…")
        lines.append(f"- Pages loaded: {', '.join(tr['pages_loaded']) or '(none)'}")
        lines.append(f"- Operations planned: {len(tr['operations'])}")
        for op in tr["operations"]:
            lines.append(f"  - {op}")
        if tr["rejected"]:
            lines.append(f"- Rejected: {', '.join(tr['rejected'])}")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def _run(args: argparse.Namespace) -> None:
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    run_id = args.run_id or datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    gt_content = input_path.read_text(encoding="utf-8")
    ground_truth = parse_ground_truth(gt_content)
    if not ground_truth:
        print("ERROR: no facts (F01: ...) found in input file", file=sys.stderr)
        sys.exit(1)

    print(f"[benchmark] Run: {run_id}")
    print(f"[benchmark] Ground truth: {len(ground_truth)} facts")

    ingestion_text = extract_all_facts_text(input_path)

    # Topic split
    if args.no_split:
        topics = [ingestion_text]
    else:
        print("[benchmark] Running topic split…")
        topics = await split_into_topics(ingestion_text)
    print(f"[benchmark] Topics: {len(topics)}")

    # Dry-run gather + plan per topic
    t_start = asyncio.get_event_loop().time()
    topic_results: list[dict[str, Any]] = []
    all_op_descriptions: list[str] = []
    all_op_types: list[str] = []

    for i, topic in enumerate(topics, 1):
        print(f"[benchmark] Topic {i}/{len(topics)}: {topic[:60]}…")
        tr = await dry_run_topic(topic)
        topic_results.append(tr)
        all_op_descriptions.extend(tr["operations"])
        all_op_types.extend(tr["op_types"])
        if args.verbose:
            for op in tr["operations"]:
                print(f"  ✓ {op}")

    elapsed = asyncio.get_event_loop().time() - t_start

    # Score
    scores = score(ground_truth, all_op_descriptions, verbose=args.verbose)

    print()
    print("=" * 60)
    print(
        f"  RECALL:    {scores['recall']:.1%}"
        f"  ({scores['found_facts']}/{scores['total_facts']} facts)"
    )
    grounded = scores["total_ops"] - scores["potential_hallucinations"]
    print(
        f"  PRECISION: {scores['precision']:.1%}"
        f"  ({grounded}/{scores['total_ops']} ops grounded)"
    )
    print(f"  Total ops: {scores['total_ops']}")
    print(f"  Elapsed:   {elapsed:.1f}s")
    print("=" * 60)

    if scores["missing_ids"]:
        print(f"\nMissing facts: {', '.join(scores['missing_ids'])}")
    if scores["hallucinated_ops"]:
        print(f"\nPotential hallucinations: {len(scores['hallucinated_ops'])} ops")

    # Persist
    split_used = not args.no_split
    report_md = format_report(
        run_id, ground_truth, topic_results, scores, elapsed, split_used
    )
    report_data = {
        "run_id": run_id,
        "timestamp": datetime.now().isoformat(),
        "input_file": str(input_path),
        "split_used": not args.no_split,
        "topics": len(topics),
        "elapsed_seconds": round(elapsed, 1),
        "scores": scores,
        "op_type_distribution": {ot: all_op_types.count(ot) for ot in set(all_op_types)},
        "topic_results": [
            {k: v for k, v in tr.items() if k != "raw_ops"}
            for tr in topic_results
        ],
    }

    json_path = output_dir / f"{run_id}.json"
    md_path = output_dir / f"{run_id}.md"
    json_path.write_text(json.dumps(report_data, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(report_md, encoding="utf-8")
    print("\n[benchmark] Reports saved:")
    print(f"  JSON: {json_path}")
    print(f"  MD:   {md_path}")

    # Scorecard index
    index_path = output_dir / "scorecard_index.json"
    index: list[dict[str, Any]] = []
    if index_path.exists():
        try:
            index = json.loads(index_path.read_text(encoding="utf-8"))
        except Exception:
            index = []
    index.append({
        "run_id": run_id,
        "timestamp": report_data["timestamp"],
        "recall": scores["recall"],
        "precision": scores["precision"],
        "total_ops": scores["total_ops"],
        "found_facts": scores["found_facts"],
        "total_facts": scores["total_facts"],
        "elapsed_seconds": round(elapsed, 1),
    })
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  Index: {index_path} ({len(index)} run(s) total)")


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingestion Benchmark / Dry-Run Tool")
    parser.add_argument(
        "--input",
        default=str(Path(__file__).parent / "ground_truth.md"),
        help="Input file with ground truth facts (default: benchmark/ground_truth.md)",
    )
    parser.add_argument("--run-id", default="", help="Name for this run (default: timestamp)")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).parent / "runs"),
        help="Output directory for reports (default: benchmark/runs/)",
    )
    parser.add_argument("--no-split", action="store_true", help="Skip topic split")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
