"""Synthetic inline-comment scope regressions checked against Marked 12.0.2.

Only comment termination across selected block and GFM cell boundaries is covered.
These expectations concern lexer text/HTML tokens, not browser HTML interpretation,
sanitization, or general Markdown parity. Marked is not a runtime test dependency.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_links


@pytest.mark.parametrize(
    "markdown,expected",
    [
        ("text<!-- hidden\n# Heading [[shown]]\n-->[[tail]]", {"shown", "tail"}),
        ("text<!-- [[shown]]\n\ncontinued -->[[tail]]", {"shown", "tail"}),
        ("# Title<!-- [[shown]]\ncontinued -->[[tail]]", {"shown", "tail"}),
        ("text<!-- [[shown]]\n---\n-->[[tail]]", {"shown", "tail"}),
        ("text<!-- [[shown]]\n- next -->[[tail]]", {"shown", "tail"}),
        (
            "text<!-- [[shown]]\n```\n-->[[code]]\n```\n[[tail]]",
            {"shown", "tail"},
        ),
        (
            "> text<!-- [[shown]]\n> # Heading [[heading]]\n> -->[[tail]]",
            {"shown", "heading", "tail"},
        ),
        ("- text<!-- [[shown]]\n\n  next -->[[tail]]", {"shown", "tail"}),
        (
            "| a | b |\n| - | - |\n| text<!-- [[shown]] | -->[[tail]] |",
            {"shown", "tail"},
        ),
        (
            "| a |\n| - |\n| text<!-- [[shown]] |\n| -->[[tail]] |",
            {"shown", "tail"},
        ),
        ("| text<!-- [[shown]] | -->[[tail]] |\n| - | - |", {"shown", "tail"}),
    ],
)
def test_later_comment_close_does_not_cross_inline_scope(markdown: str, expected: set[str]) -> None:
    assert {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))} == expected


@pytest.mark.parametrize(
    "markdown,expected",
    [
        ("text<!-- [[hidden]]\ncontinued -->[[tail]]", {"tail"}),
        ("> text<!-- [[hidden]]\n> continued -->[[tail]]", {"tail"}),
        ("- text<!-- [[hidden]]\n  continued -->[[tail]]", {"tail"}),
        ("| a |\n| - |\n| text<!-- [[hidden]] -->[[tail]] |", {"tail"}),
        (
            "| a |\n| - |\n| text<!-- [[hidden]] \\| inside -->[[tail]] |",
            {"tail"},
        ),
        ("<!-- [[hidden]]\n# Still hidden [[hidden2]]\n-->[[hidden3]]\n[[tail]]", {"tail"}),
    ],
)
def test_comment_scope_controls_keep_valid_comments_hidden(
    markdown: str, expected: set[str]
) -> None:
    assert {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))} == expected


def test_comment_scopes_keep_crlf_source_and_rebuild_store_projections(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("shown", "tail", "hidden", "code"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "# Actual<!-- heading\r\n\r\n"
        "Intro<!-- unfinished [[shown|companion]]\r\n"
        "# Section\r\n"
        "-->[[tail|ending]]\r\n\r\n"
        "<!-- [[hidden]] -->\r\n"
        "```html\r\n[[code]]\r\n```\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "Actual<!-- heading"
    assert saved["excerpt"] == "Intro<!-- unfinished companion -->ending"
    assert saved["markdown"] == markdown
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    reopened = WikiStore(store.path)
    current = reopened.get_page("source")
    assert current is not None
    assert current["markdown"] == markdown
    assert current["title"] == saved["title"]
    assert current["excerpt"] == saved["excerpt"]
    assert reopened.graph()["edges"] == [
        {"source": "source", "target": "shown", "type": "wikilink"},
        {"source": "source", "target": "tail", "type": "wikilink"},
    ]
    assert reopened.graph()["missing_targets"] == []
    for target in ("shown", "tail"):
        assert reopened.backlinks(target)["total"] == 1
    for target in ("hidden", "code"):
        assert reopened.backlinks(target)["total"] == 0

    changed = "# Changed\r\n\r\n[[hidden]]\r\n"
    reopened.save_page("source", changed, saved["revision"], "changed")
    updated = WikiStore(store.path)
    assert updated.backlinks("shown")["total"] == 0
    assert updated.backlinks("tail")["total"] == 0
    assert updated.backlinks("hidden")["total"] == 1
    assert len(updated.history("source")) == 2
    assert updated._git("show", "HEAD:pages/source.md") == changed.encode()
    assert updated._git("show", "HEAD~1:pages/source.md") == markdown.encode()
