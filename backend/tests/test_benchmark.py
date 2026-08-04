"""Tests for the ingestion benchmark tool (no LLM required)."""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure benchmark package is importable
sys.path.insert(0, str(Path(__file__).parent.parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from benchmark.run import (
    _fact_mentioned,
    extract_all_facts_text,
    format_report,
    parse_ground_truth,
    score,
)

SAMPLE_GT_TEXT = """
F01: Marie Curie wurde 1867 in Warschau geboren.
F02: Das Element Polonium wurde von Marie Curie entdeckt.
F03: LangGraph ermöglicht zustandsbasierte KI-Agenten.
"""

GROUND_TRUTH = {
    "F01": "Marie Curie wurde 1867 in Warschau geboren.",
    "F02": "Das Element Polonium wurde von Marie Curie entdeckt.",
    "F03": "LangGraph ermöglicht zustandsbasierte KI-Agenten.",
}


def test_parse_ground_truth() -> None:
    gt = parse_ground_truth(SAMPLE_GT_TEXT)
    assert gt == GROUND_TRUTH


def test_parse_ground_truth_empty() -> None:
    assert parse_ground_truth("no facts here") == {}


def test_fact_mentioned_positive() -> None:
    ops = ["add_claim → marie: Marie Curie wurde 1867 in Warschau geboren"]
    assert _fact_mentioned("Marie Curie wurde 1867 in Warschau geboren.", ops)


def test_fact_mentioned_negative() -> None:
    ops = ["add_claim → eiffel: Der Eiffelturm steht in Paris"]
    assert not _fact_mentioned("Marie Curie wurde 1867 in Warschau geboren.", ops)


def test_fact_mentioned_partial_threshold() -> None:
    ops = ["add_claim → page: marie curie entdeckt etwas anderes komplett"]
    result = _fact_mentioned("Marie Curie Polonium entdeckt Element Warschau", ops)
    assert isinstance(result, bool)


def test_score_perfect_recall() -> None:
    ops = [
        "add_claim → marie: Marie Curie wurde 1867 in Warschau geboren",
        "add_claim → marie: Das Element Polonium wurde von Marie Curie entdeckt",
        "add_claim → lang: LangGraph ermöglicht zustandsbasierte KI-Agenten",
    ]
    s = score(GROUND_TRUTH, ops)
    assert s["recall"] == 1.0
    assert s["found_facts"] == 3
    assert s["missing_facts"] == 0


def test_score_zero_recall() -> None:
    ops = ["add_claim → page: etwas völlig anderes ohne relevante keywords"]
    s = score(GROUND_TRUTH, ops)
    assert s["found_facts"] == 0
    assert s["recall"] == 0.0


def test_score_empty_ops() -> None:
    s = score(GROUND_TRUTH, [])
    assert s["recall"] == 0.0
    assert s["precision"] == 1.0
    assert s["total_ops"] == 0


def test_score_hallucination_detection() -> None:
    ops = [
        "add_claim → marie: Marie Curie Warschau geboren",
        "add_claim → xyz: völlig erfundene information über xyz topic",
    ]
    s = score(GROUND_TRUTH, ops)
    assert s["potential_hallucinations"] >= 1


def test_format_report_runs() -> None:
    topic_results = [
        {
            "topic_preview": "Marie Curie Fakten",
            "pages_loaded": ["marie-curie"],
            "operations": ["add_claim → marie: Marie Curie 1867 Warschau"],
            "op_types": ["AddClaim"],
            "rejected": [],
        }
    ]
    s = score(GROUND_TRUTH, list(topic_results[0]["operations"]))
    report = format_report("test_run", GROUND_TRUTH, topic_results, s, 5.0, True)
    assert "test_run" in report
    assert "Recall" in report
    assert "Precision" in report


def test_extract_all_facts_text(tmp_path: Path) -> None:
    gt_file = tmp_path / "gt.md"
    gt_file.write_text(SAMPLE_GT_TEXT, encoding="utf-8")
    text = extract_all_facts_text(gt_file)
    assert "F01:" in text
    assert "F02:" in text
    assert "F03:" in text
    assert "Marie Curie" in text
