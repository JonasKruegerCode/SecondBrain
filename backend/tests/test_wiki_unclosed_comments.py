"""EOF inline-comment cases checked against installed Marked 12.0.2.

Marked's inline comment token requires a closing delimiter; its block comment
token can consume EOF. These cases intentionally avoid a later delimiter in a
different inline scope, which requires separate parser-boundary work.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_links


@pytest.mark.parametrize(
    "markdown,expected",
    [
        ("text<!-- unfinished [[shown]]", {"shown"}),
        ("text<!-- unfinished\n[[shown]]", {"shown"}),
        ("# Title<!-- unfinished [[shown]]", {"shown"}),
        ("text<!-- unfinished\n\n[[shown]]", {"shown"}),
        ("> text<!-- unfinished\n> [[shown]]", {"shown"}),
        ("- text<!-- unfinished\n  [[shown]]", {"shown"}),
        ("| h |\n| - |\n| text<!-- unfinished [[shown]] |", {"shown"}),
        ("text<!-- one <!-- two [[shown]]", {"shown"}),
        (
            "text<!-- unfinished\n\n```\n[[code]]\n```\n[[shown]]",
            {"shown"},
        ),
        ("text<!-- unfinished\n\n<!-- block [[hidden]]", set()),
        ("<!-- unfinished\n[[hidden]]", set()),
        ("> <!-- unfinished\n> [[hidden]]", set()),
        ("- <!-- unfinished\n  [[hidden]]", set()),
        ("`text<!-- unfinished [[hidden]]` [[shown]]", {"shown"}),
        ("```\ntext<!-- unfinished [[hidden]]\n```\n[[shown]]", {"shown"}),
        ("text<!-- [[hidden]]\ncontinued -->[[shown]]", {"shown"}),
        ("> text<!-- [[hidden]]\n> continued -->[[shown]]", {"shown"}),
        ("- text<!-- [[hidden]]\n  continued -->[[shown]]", {"shown"}),
        ("text<!-->[[shown]]", {"shown"}),
        ("text<!--->[[shown]]", {"shown"}),
    ],
)
def test_unclosed_inline_comment_is_literal_but_block_comments_still_hide_links(
    markdown: str, expected: set[str]
) -> None:
    assert {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))} == expected


def test_unclosed_inline_comment_store_projections_preserve_crlf_history(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("visible", "hidden"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "# Actual<!-- unfinished heading\r\n\r\n"
        "Visible [[visible|companion]].\r\n\r\n"
        "```html\r\n<!-- unfinished [[hidden]]\r\n```\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "Actual<!-- unfinished heading"
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

    changed = "# Changed\r\n\r\n[[hidden]]\r\n"
    store.save_page("source", changed, saved["revision"], "changed")
    reopened = WikiStore(store.path)
    current = reopened.get_page("source")
    assert current is not None
    assert current["markdown"] == changed
    assert current["title"] == "Changed"
    assert current["excerpt"] == "hidden"
    assert reopened.backlinks("visible")["total"] == 0
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD:pages/source.md") == changed.encode()
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
