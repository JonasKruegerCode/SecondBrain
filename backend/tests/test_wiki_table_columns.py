"""Bounded GFM table-column regressions against installed Marked 12.0.2."""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_links


@pytest.mark.parametrize(
    "body,expected",
    [
        ("a | b\n--- | ---\nx | y | [[hidden]]", set()),
        ("a | b\n--- | --- | ---\n`x | [[hidden]]`", set()),
        ("a | b\n-\n`x | [[hidden]]`", set()),
        ("| a | b |\n| --- | --- |\nx | [[shown]] | [[hidden]]", {"shown"}),
        ("a | b\n:--- | ---:\n[[shown]]", {"shown"}),
        (r"a \| b | c" + "\n--- | ---\nx | [[shown]] | [[hidden]]", {"shown"}),
        (r"a \\| b | c" + "\n--- | ---\n`x | [[hidden]]`", set()),
        ("| a | b |\n| --- | --- |\n| `x | [[shown]]` | [[hidden]] |", {"shown"}),
        ("| a | b |\n| --- | --- |\n| x | [[shown\\|Label]] | [[hidden]] |", {"shown"}),
        ("a\n:---\n[[shown]] | [[hidden]]", {"shown"}),
        ("a | b\n--- | ---\n| | [[shown]] | [[hidden]] |", {"shown"}),
        ("a | b\n--- | ---\n[[hidden | label]]", set()),
    ],
)
def test_table_columns_match_visible_cells(body: str, expected: set[str]) -> None:
    assert {m.group(1) for m in LINK_RE.finditer(prose_links(body))} == expected


def test_table_projection_preserves_source_history_and_backlinks(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("shown", "hidden"):
        store.save_page(target, f"# {target}", None, target)
    markdown = "# Table source\r\n\r\na | b\r\n--- | ---\r\nx | [[shown]] | [[hidden]]\r\n"
    saved = store.save_page("source", markdown, None, "source")
    reopened = WikiStore(tmp_path)
    assert reopened.graph()["edges"] == [
        {"source": "source", "target": "shown", "type": "wikilink"}
    ]
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    assert "hidden" not in saved["excerpt"]
    current = reopened.get_page("source")
    assert current is not None
    assert current["markdown"] == markdown
    assert current["revision"] == saved["revision"]
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    updated = reopened.save_page(
        "source", markdown + "\r\n[[hidden]]\r\n", saved["revision"], "next"
    )
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
    assert updated["revision"] != saved["revision"]


def test_table_cell_does_not_become_page_title(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    markdown = "| # Cell heading | b |\n| --- | --- |\nx | y\n"
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "source"
    assert saved["markdown"] == markdown


@pytest.mark.parametrize("outer", [False, True])
def test_table_projection_preserves_typed_relation_boundary(tmp_path: Path, outer: bool) -> None:
    store = WikiStore(tmp_path)
    store.save_page("shown", "# Shown", None, "shown")
    row = "depends:: [[shown]] | data"
    markdown = "a | b\n--- | ---\n" + (f"| {row} |" if outer else row)
    store.save_page("source", markdown, None, "source")
    edges = store.graph()["edges"]
    assert {edge["target"] for edge in edges} == {"shown"}
    assert any(edge.get("rel") == "depends" for edge in edges) is not outer
