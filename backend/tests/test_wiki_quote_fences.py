"""Synthetic quote-fence regressions against the installed Marked grammar.

The expected targets were checked with frontend's inline wikilink extension.
Marked strips quote containers before fencing, including lazy continuation lines.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize("quote", ["> ", "> > "])
@pytest.mark.parametrize("marker", ["~~~", "```"])
def test_quoted_fences_preserve_source_without_publishing_literal_links(
    tmp_path: Path, quote: str, marker: str
) -> None:
    store = WikiStore(tmp_path)
    for target in ("before", "after", "hidden"):
        store.save_page(target, f"# {target.title()}", None, target)
    markdown = (
        "# Source\n\n"
        f"{quote}[[before|Visible before]]\n{quote}\n"
        f"{quote}{marker}md\n{quote}[[hidden]] [[absent]]\n"
        f"{quote}{marker}\n{quote}\n{quote}[[after|Visible after]]\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["markdown"] == markdown
    read = store.get_page("source")
    assert read is not None
    assert read["markdown"] == markdown
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    graph = store.snapshot()["graph"]
    assert graph["edges"] == [
        {"source": "source", "target": target, "type": "wikilink"} for target in ("after", "before")
    ]
    assert graph["missing_targets"] == []
    assert graph["ambiguous_targets"] == []
    assert store.backlinks("hidden")["total"] == 0
    assert store.backlinks("before")["total"] == 1
    assert store.backlinks("after")["total"] == 1


# Keep the boundary corpus independent of git setup: _page and _graph are the
# same projection methods used by real reads and snapshots above.
QUOTE_FENCE_CASES = [
    ("tilde-exact", "> ~~~md\n> [[hidden]]\n> ~~~\n> [[visible]]", {"visible"}),
    ("backtick-exact", "> ```md\n> [[hidden]]\n> ```\n> [[visible]]", {"visible"}),
    ("longer-close", "> ~~~\n> [[hidden]]\n> ~~~~\n> [[visible]]", {"visible"}),
    ("shorter-close", "> ~~~~\n> [[hidden]]\n> ~~~\n> [[also-hidden]]", set()),
    ("wrong-marker", "> ~~~\n> [[hidden]]\n> ```\n> [[also-hidden]]", set()),
    ("backtick-wrong-marker", "> ```\n> [[hidden]]\n> ~~~\n> [[also-hidden]]", set()),
    ("mixed-close-suffix", "> ~~~\n> [[hidden]]\n> ~~~`\n> [[visible]]", {"visible"}),
    ("close-with-info", "> ~~~\n> [[hidden]]\n> ~~~md\n> [[also-hidden]]", set()),
    ("unclosed-eof", "> ~~~md\n> [[hidden]]", set()),
    ("unclosed-blank-boundary", "> ~~~md\n> [[hidden]]\n\n[[visible]]", {"visible"}),
    ("unclosed-heading-boundary", "> ~~~md\n> [[hidden]]\n# Outside\n[[visible]]", {"visible"}),
    ("quoted-blank-stays-code", "> ~~~\n> [[hidden]]\n>\n> [[also-hidden]]", set()),
    ("lazy-unquoted", "> ~~~md\n[[hidden]]\n> ~~~\n> [[visible]]", {"visible"}),
    ("lazy-unclosed", "> ~~~md\n[[hidden]]\nplain [[also-hidden]]", set()),
    ("lazy-decreased-depth", "> > ~~~md\n> [[hidden]]\n> > ~~~\n> > [[visible]]", {"visible"}),
    ("lazy-zero-depth-nested", "> > ```md\n[[hidden]]\n> > ```\n> > [[visible]]", {"visible"}),
    ("nested-heading-boundary", "> > ~~~\n> > [[hidden]]\n# Outside\n[[visible]]", {"visible"}),
    (
        "indented-quote",
        "   >   ~~~md\n   >   [[hidden]]\n   >   ~~~\n   > [[visible]]",
        {"visible"},
    ),
    ("list-outdented-prose", "- item\n\n  > ~~~\n[[visible]]\n\n[[before]]", {"before", "visible"}),
    (
        "list-outdented-quote",
        "- item\n\n  > ~~~\n> [[visible]]\n\n[[before]]",
        {"before", "visible"},
    ),
    ("list-indented-code-control", "- item\n\n  > ~~~\n  > [[hidden]]\n\n[[visible]]", {"visible"}),
    ("backtick-info-invalid", "> ```bad`info\n> [[visible]]", {"visible"}),
    (
        "fence-after-quoted-prose",
        "> [[before]]\n> ~~~\n> [[hidden]]\n> ~~~\n> [[visible]]",
        {"before", "visible"},
    ),
]


@pytest.mark.parametrize(
    "name,markdown,expected", QUOTE_FENCE_CASES, ids=[case[0] for case in QUOTE_FENCE_CASES]
)
def test_quote_fence_boundaries_match_rendered_wikilinks(
    name: str, markdown: str, expected: set[str]
) -> None:
    source = WikiStore._page("source", markdown.encode(), "synthetic-revision")
    targets = [
        WikiStore._page(target, f"# {target}".encode(), "synthetic-revision")
        for target in ("before", "visible", "hidden", "also-hidden")
    ]
    graph = WikiStore._graph([source, *targets], "synthetic-head")
    assert source["markdown"] == markdown
    assert graph["edges"] == [
        {"source": "source", "target": target, "type": "wikilink"} for target in sorted(expected)
    ], name
    assert graph["missing_targets"] == []
    assert graph["ambiguous_targets"] == []


def test_deep_quote_nesting_does_not_use_python_recursion() -> None:
    quote = "> " * 150
    markdown = f"{quote}~~~md\n{quote}[[hidden]]\n{quote}~~~\n\n[[visible]]"
    source = WikiStore._page("source", markdown.encode(), "synthetic-revision")
    visible = WikiStore._page("visible", b"# Visible", "synthetic-revision")
    graph = WikiStore._graph([source, visible], "synthetic-head")
    assert source["markdown"] == markdown
    assert graph["edges"] == [{"source": "source", "target": "visible", "type": "wikilink"}]
    assert graph["missing_targets"] == []


def test_top_level_quote_ends_prior_list_indentation() -> None:
    markdown = "- Item\n\n> Quoted prose\n\n    [[hidden]]\n\n# Actual heading\n\n[[visible]]"
    source = WikiStore._page("source", markdown.encode(), "synthetic")
    graph = WikiStore._graph([source], "synthetic")
    assert source["title"] == "Actual heading"
    assert graph["missing_targets"] == [{"source": "source", "target": "visible"}]


def test_quoted_heading_cannot_become_page_identity() -> None:
    markdown = (
        "> # Quoted heading\n>\n> ~~~md\n> # Example heading\n> ~~~\n\n"
        "# Actual heading\n\nReal prose."
    )
    source = WikiStore._page("source", markdown.encode(), "synthetic")
    assert source["title"] == "Actual heading"
    assert source["excerpt"] == "Real prose."
    assert source["markdown"] == markdown


def test_quoted_wikilink_preserves_internal_tab_for_title_resolution(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("target", "# Title\twith tab", None, "target")
    markdown = "> [[Title\twith tab|Visible label]]\n"
    store.save_page("source", markdown, None, "source")
    read = store.get_page("source")
    assert read is not None
    assert read["markdown"] == markdown
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    graph = store.graph()
    assert graph["edges"] == [{"source": "source", "target": "target", "type": "wikilink"}]
    assert graph["missing_targets"] == []
    assert graph["ambiguous_targets"] == []
    assert store.backlinks("target")["total"] == 1


@pytest.mark.parametrize("marker", ["~~~", "```"])
def test_quoted_fence_closer_with_trailing_tab_remains_literal(marker: str) -> None:
    # Native Marked's closing regex allows spaces, but does not accept a tab.
    markdown = f"> {marker}\n> [[hidden]]\n> {marker}\t\n> [[also-hidden]]"
    source = WikiStore._page("source", markdown.encode(), "synthetic-revision")
    targets = [
        WikiStore._page(target, f"# {target}".encode(), "synthetic-revision")
        for target in ("hidden", "also-hidden")
    ]
    graph = WikiStore._graph([source, *targets], "synthetic-head")
    assert source["markdown"] == markdown
    assert graph["edges"] == []
    assert graph["missing_targets"] == []
    assert graph["ambiguous_targets"] == []
