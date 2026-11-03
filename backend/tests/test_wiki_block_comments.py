"""Literal block-comment boundaries checked against installed Marked 12.

HTML tokenization, not browser comment parsing or sanitizer behavior.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_blocks, prose_links


@pytest.mark.parametrize(
    "markdown,expected",
    [
        ("<!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("   <!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("<!--\n[[hidden]]\n\n-->[[absent]]\n[[visible]]", {"visible"}),
        ("<!-->[[hidden]]\n[[visible]]", {"visible"}),
        ("<!--->[[hidden]]\n[[visible]]", {"visible"}),
        ("<!-- unfinished\n[[hidden]]", set()),
        ("<!--x--!>\n[[hidden]]", set()),
        ("<!--x-->[[hidden]]\r\n[[visible]]", {"visible"}),
        ("text\n<!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("text\n <!--x-->[[visible]]", {"visible"}),
        ("text <!--x-->[[visible]]", {"visible"}),
        ("a|b\n-|-\n<!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("a|b\n-|-\n <!--x-->[[visible]]", {"visible"}),
        ("- text\n  <!--x-->[[hidden]]\n  [[visible]]", {"visible"}),
        ("> <!--x-->[[hidden]]\n> [[visible]]", {"visible"}),
        ("> text\n<!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("<?p?><!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("<!A><!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("<![CDATA[x]]><!--x-->[[hidden]]\n[[visible]]", {"visible"}),
        ("```html\n<!--x-->[[hidden]]\n```\n[[visible]]", {"visible"}),
        ("    <!--x-->[[hidden]]\n\n[[visible]]", {"visible"}),
        ("`<!--x-->[[hidden]]` [[visible]]", {"visible"}),
        ("\\<!--x-->[[visible]]", {"visible"}),
        ("<! --x-->[[visible]]", {"visible"}),
        ("<!-x-->[[visible]]", {"visible"}),
    ],
)
def test_block_comment_prose_boundaries(markdown: str, expected: set[str]) -> None:
    assert {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))} == expected


def test_comment_closing_line_does_not_create_a_title() -> None:
    projected = prose_blocks("<!--\n# Ghost\n--># Fake\n# Real")
    assert "# Ghost" not in projected
    assert "# Fake" not in projected
    assert "# Real" in projected


def test_block_comments_preserve_git_source_and_publish_only_prose(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "visible"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "<!--\r\n# Ghost\r\n[[hidden]]\r\n-->[[absent]]\r\n"
        "# Real\r\n\r\nVisible [[visible|companion]].\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "Real"
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
    assert store.backlinks("hidden")["total"] == 0
    assert store.backlinks("visible")["total"] == 1
    store.save_page("source", "# Changed\n\n[[hidden]]", saved["revision"], "changed")
    reopened = WikiStore(store.path)
    assert reopened.backlinks("hidden")["total"] == 1
    assert reopened.backlinks("visible")["total"] == 0
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
