"""Bound repeated parser work without machine-dependent wall-clock thresholds."""

import re
from pathlib import Path

import pytest

from second_brain.wiki import store


@pytest.mark.parametrize(
    "suffix,expected",
    [
        ("." * 20_000, "https://a"),
        (";." * 10_000, "https://a"),
        ("(" * 10_000 + ")" * 10_000, "https://a" + "(" * 10_000 + ")"),
        ("&name;", "https://a"),
        ("&name;...", "https://a"),
        ("&name;;", "https://a"),
        ("&;", "https://a&"),
        ("&é;", "https://a&é"),
        ("(a&name;)", "https://a(a&name;)"),
        ("()...", "https://a()"),
    ],
    ids=[
        "periods",
        "mixed-punctuation",
        "parentheses",
        "entity",
        "entity-periods",
        "entity-semicolon",
        "empty-entity",
        "unicode-entity",
        "parenthesized-entity",
        "balanced-parentheses",
    ],
)
def test_url_tail_keeps_marked_result_with_bounded_regex_work(
    monkeypatch: pytest.MonkeyPatch, suffix: str, expected: str
) -> None:
    original = store._URL_BACKPEDAL_RE
    lengths: list[int] = []

    class CountedRegex:
        def match(self, text: str) -> re.Match[str] | None:
            lengths.append(len(text))
            return original.match(text)

    monkeypatch.setattr(store, "_URL_BACKPEDAL_RE", CountedRegex())
    markdown = "https://a" + suffix
    end = store._autolink_end(markdown, 0)
    assert markdown[:end] == expected
    assert len(lengths) <= 3
    assert sum(lengths) <= 3 * len(markdown)


def test_short_comments_search_the_original_string(monkeypatch: pytest.MonkeyPatch) -> None:
    markdown = "x " + "<!-->" * 20_000 + " [[shown]]"
    original = store._COMMENT_TOKEN_RE
    positions: list[int] = []

    class CountedRegex:
        def search(self, text: str, position: int) -> re.Match[str] | None:
            assert text is markdown
            positions.append(position)
            return original.search(text, position)

    monkeypatch.setattr(store, "_COMMENT_TOKEN_RE", CountedRegex())
    assert store._without_comments(markdown, False, has_later_close=False) == (
        "x  [[shown]]",
        False,
    )
    assert len(positions) == 20_001
    assert positions == sorted(set(positions))


def test_projection_optimization_preserves_source_graph_and_history(tmp_path: Path) -> None:
    wiki = store.WikiStore(tmp_path)
    for key in ["hidden", "shown"]:
        wiki.save_page(key, f"# {key}", None, key)
    markdown = (
        "# Synthetic parser boundary\r\n\r\n"
        + "x <!-->" * 200
        + " https://example.test/[[hidden]]"
        + "." * 2_000
        + " [[shown|Visible companion]]\r\n"
    )
    saved = wiki.save_page("source", markdown, None, "source")
    assert wiki.get_page("source")["markdown"] == markdown
    assert wiki.backlinks("hidden")["total"] == 0
    assert wiki.backlinks("shown")["total"] == 1
    assert wiki._git("show", "HEAD:pages/source.md") == markdown.encode()
    wiki.save_page("source", markdown + "\r\n[[hidden]]", saved["revision"], "next")
    reopened = store.WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
