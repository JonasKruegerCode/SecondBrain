"""Short inline comment tokens checked against installed Marked 12.0.2.

These cases concern HTML token boundaries, not sanitizer/browser behavior or
general Markdown compatibility. Block comments retain their separate rules.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_links


@pytest.mark.parametrize("comment", ["<!-->", "<!--->"])
@pytest.mark.parametrize(
    "template",
    [
        "text{comment}[[visible]]",
        "# Title{comment} suffix [[visible]]",
        "h\n-\ntext{comment}[[visible]]",
        "| h |\n| - |\n| text{comment}[[visible]] |",
        "- text{comment}[[visible]]",
        "> text{comment}[[visible]]",
        "text{comment}[[visible]]\ncontinued [[later]]",
    ],
)
def test_short_inline_comment_keeps_following_prose(comment: str, template: str) -> None:
    markdown = template.format(comment=comment)
    expected = {"visible", "later"} if "[[later]]" in markdown else {"visible"}
    assert {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))} == expected


@pytest.mark.parametrize("comment", ["<!-->", "<!--->"])
@pytest.mark.parametrize(
    "template,expected",
    [
        ("{comment}[[hidden]]\n[[visible]]", {"visible"}),
        ("text<!-- [[hidden]] -->[[visible]]", {"visible"}),
        ("text<!-- [[hidden]]\ncontinued -->[[visible]]", {"visible"}),
        ("<!-- unfinished\n[[hidden]]", set()),
        ("`text{comment}[[hidden]]` [[visible]]", {"visible"}),
        ("```html\ntext{comment}[[hidden]]\n```\n[[visible]]", {"visible"}),
        ("    text{comment}[[hidden]]\n\n[[visible]]", {"visible"}),
    ],
)
def test_short_inline_comment_preserves_block_and_code_controls(
    comment: str, template: str, expected: set[str]
) -> None:
    assert {
        match.group(1)
        for match in LINK_RE.finditer(prose_links(template.format(comment=comment)))
    } == expected


@pytest.mark.parametrize("comment", ["<!-->", "<!--->"])
def test_short_inline_comment_store_projections_preserve_source_history(
    tmp_path: Path, comment: str
) -> None:
    store = WikiStore(tmp_path)
    for target in ("visible", "hidden"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        f"# Actual{comment} heading\r\n\r\n"
        f"Visible{comment} [[visible|companion]].\r\n"
        "<!-- [[hidden]] -->\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "Actual heading"
    assert saved["excerpt"] == "Visible companion."
    assert saved["markdown"] == markdown
    current = store.get_page("source")
    assert current is not None
    assert current["markdown"] == markdown
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    assert store.graph()["edges"] == [
        {"source": "source", "target": "visible", "type": "wikilink"}
    ]
    assert store.graph()["missing_targets"] == []
    assert store.backlinks("visible")["total"] == 1
    assert store.backlinks("hidden")["total"] == 0
    store.save_page("source", "# Changed\n\n[[hidden]]", saved["revision"], "changed")
    reopened = WikiStore(store.path)
    assert reopened.backlinks("visible")["total"] == 0
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
