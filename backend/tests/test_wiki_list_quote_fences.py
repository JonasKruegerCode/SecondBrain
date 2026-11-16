"""List/quote boundary regressions against the installed frontend Marked lexer."""

import subprocess
from pathlib import Path

import pytest

from second_brain.wiki.store import WikiStore, prose_links

# Expected links were checked with native Marked 12, not a Python Markdown parser.
CASES = [
    pytest.param("- > ~~~\n> [[x]]\n\n[[y]]", ["y"], id="outdented-quote"),
    pytest.param("- > ~~~\n  > [[x]]\n\n[[y]]", ["y"], id="indented-quote"),
    pytest.param("- > ~~~\n  > [[x]]\n  > ~~~\n  > [[y]]", ["y"], id="closed"),
    pytest.param("- > ~~~\n  > [[x]]\n\n  [[y]]", ["y"], id="quote-exit"),
    pytest.param("- > ~~~\n[[x]]\n\n[[y]]", ["y"], id="lazy"),
    pytest.param("1. > ~~~\n> [[x]]\n\n[[y]]", ["y"], id="ordered"),
    pytest.param("123. > ~~~\n     > [[x]]\n\n[[y]]", ["y"], id="ordered-wide"),
    pytest.param("1) > ~~~\n   > [[x]]\n\n[[y]]", ["y"], id="ordered-paren"),
    pytest.param("- outer\n  - > ~~~\n    > [[x]]\n\n[[y]]", ["y"], id="nested"),
    pytest.param("- outer\n  - > ~~~\n> [[x]]\n\n[[y]]", ["y"], id="nested-outdent"),
    pytest.param("- > > ~~~\n  > > [[x]]\n\n[[y]]", ["y"], id="quote-nested"),
    pytest.param("- > ~~~\n  > [[x]]\n- [[y]]", ["y"], id="sibling"),
    pytest.param("- > ~~~\n  > [[x]]\n+ [[y]]", ["y"], id="different-sibling"),
    pytest.param("- > ```\n  > [[x]]\n  > ```\n  prose [[y]]", ["y"], id="prose-after-close"),
    pytest.param("- > # Quoted heading\n  > [[y]]\n\n# Actual heading", ["y"], id="quote-heading"),
    pytest.param(
        "- > ~~~\n  > # Fake heading\n  > [[x]]\n\n# Actual heading\n[[y]]",
        ["y"],
        id="quoted-code-heading",
    ),
    pytest.param("- > ~~~\n  > [[x]]\n  > ~~~\n  > prose\t[[y]]", ["y"], id="internal-tab"),
    pytest.param("-\t> ~~~\n  > [[x]]\n\n[[y]]", ["y"], id="tab-marker"),
    pytest.param("- > intro\n  > ~~~\n[[x]]\n\n[[y]]", ["y"], id="lazy-after-prose"),
    pytest.param("- intro\n\n  > ~~~\n  > [[x]]\n\n[[y]]", ["y"], id="blank-before-quote"),
    pytest.param("- > ~~~~\n  > [[x]]\n  > ~~~\n  > [[y]]", [], id="short-close"),
    pytest.param("- > ~~~\n  > [[x]]\n  > ~~~~\n  > [[y]]", ["y"], id="long-close"),
    pytest.param("- > ~~~\n  > [[x]]\n~~~\n[[y]]", [], id="outdented-fence"),
    pytest.param("-\n  > ~~~\n  > [[x]]\n\n[[y]]", ["y"], id="empty-item"),
    pytest.param("- \t> ~~~\n\t> [[x]]\n\n[[y]]", ["x", "y"], id="internal-marker-tab"),
    pytest.param("1.\t > ~~~\n\t> [[x]]\n\n[[y]]", ["x", "y"], id="ordered-tab-continuation"),
]


@pytest.mark.parametrize("markdown, expected", CASES)
def test_list_quote_fence_store_evidence(
    tmp_path: Path, markdown: str, expected: list[str]
) -> None:
    store = WikiStore(tmp_path / "vault")
    for target in ("x", "y"):
        store.save_page(target, f"# Target {target}", None, target)
    saved = store.save_page("source", markdown, None, "source")
    assert saved["markdown"] == markdown
    assert saved["title"] == ("Actual heading" if "# Actual heading" in markdown else "source")
    reopened = WikiStore(store.path)
    read = reopened.get_page("source")
    assert read is not None
    assert all(read[key] == saved[key] for key in read)
    raw = subprocess.run(
        ["git", "--git-dir", str(store.repo), "show", "HEAD:pages/source.md"],
        capture_output=True,
        check=True,
    ).stdout
    assert raw == markdown.encode("utf-8")
    graph = reopened.graph()
    assert graph["edges"] == [
        {"source": "source", "target": target, "type": "wikilink"} for target in expected
    ]
    assert graph["missing_targets"] == []
    assert graph["ambiguous_targets"] == []
    assert reopened.backlinks("x")["total"] == int("x" in expected)
    assert reopened.backlinks("y")["total"] == int("y" in expected)


def test_list_quote_edit_recomputes_backlinks_from_saved_bytes(tmp_path: Path) -> None:
    store = WikiStore(tmp_path / "vault")
    for target in ("x", "y"):
        store.save_page(target, f"# Target {target}", None, target)
    before = store.save_page("source", "- > ~~~\n> [[x]]\n\n[[y]]", None, "before")
    assert store.backlinks("y")["total"] == 1
    markdown = "- > ~~~\n> [[x]]\n> [[y]]\n"
    after = store.save_page("source", markdown, before["revision"], "after")
    reopened = WikiStore(store.path)
    read = reopened.get_page("source")
    assert read is not None
    assert read["markdown"] == markdown
    assert reopened.graph()["edges"] == []
    assert reopened.backlinks("x")["total"] == 0
    assert reopened.backlinks("y")["total"] == 0
    assert after["revision"] != before["revision"]


@pytest.mark.parametrize("indent", ["", "  "])
def test_list_comments_keep_hidden_links_literal(tmp_path: Path, indent: str) -> None:
    store = WikiStore(tmp_path / "vault")
    store.save_page("hidden", "# Hidden", None, "hidden")
    store.save_page("visible", "# Visible", None, "visible")
    markdown = f"- <!--\n{indent}[[hidden]]\n{indent}-->\n\n[[visible]]"
    saved = store.save_page("source", markdown, None, "source")
    assert saved["markdown"] == markdown
    assert store.graph()["edges"] == [{"source": "source", "target": "visible", "type": "wikilink"}]
    assert store.backlinks("hidden")["total"] == 0
    assert store.backlinks("visible")["total"] == 1


def test_list_quote_preserves_neighbor_excerpt(tmp_path: Path) -> None:
    store = WikiStore(tmp_path / "vault")
    for target in ("x", "y"):
        store.save_page(target, f"# Target {target}", None, target)
    markdown = "- Before [[y]].\n\n  > ~~~\n  > [[x]]\n  > ~~~\n\n  After [[y]].\n\nTail [[y]]."
    saved = store.save_page("source", markdown, None, "source")
    assert saved["excerpt"] == "Before y. After y. Tail y."
    assert store.graph()["edges"] == [{"source": "source", "target": "y", "type": "wikilink"}]


def test_deep_list_quote_projection_uses_work_stack() -> None:
    prefix = "> " * 150
    markdown = prefix + "- > ~~~\n" + prefix + "  > [[x]]\n\n[[y]]"
    projected = prose_links(markdown)
    assert "[[x]]" not in projected
    assert "[[y]]" in projected
