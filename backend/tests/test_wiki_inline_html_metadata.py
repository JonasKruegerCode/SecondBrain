"""Inline HTML metadata is not a rendered wikilink (Marked12 contract)."""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, _markdown_escaped, prose_links


@pytest.mark.parametrize(
    "body,expected",
    [
        ('See <a href="https://example.test/docs" title="See [[hidden]]">docs</a>.', set()),
        ('text <a href="/wiki/other" title="[[hidden]]">label</a> [[shown]]', {"shown"}),
        ("text <a title='[[hidden]] > note' href='/wiki/other'>[[shown]]</a>", {"shown"}),
        ('text <a title="[[hidden]] < note">[[shown]]</a>', {"shown"}),
        ('text <A TITLE="[[hidden]]">[[shown]]</A>', {"shown"}),
        ('text <span title="[[hidden]]">[[shown]]</span>', {"shown"}),
        ('text <img src="image.svg" alt="[[hidden]]"> [[shown]]', {"shown"}),
        ("text <em data-note=[[hidden]]>[[shown]]</em>", {"shown"}),
        ('text <a title="first\n[[hidden]]">[[shown]]</a>', {"shown"}),
        ('text <a title="[[hidden]]">https://example.test/[[shown]]</a>', {"shown"}),
        (
            'text <a title="[[hidden]]">docs</a> https://example.test/[[hidden]] [[shown]]',
            {"shown"},
        ),
        ('text <span data-é="[[shown]]">label</span>', {"shown"}),
        ('text <spané title="[[shown]]">label</span>', {"shown"}),
        ('text <span\u0085title="[[shown]]">label</span>', {"shown"}),
        ('text <span\u001ctitle="[[shown]]">label</span>', {"shown"}),
        ("text <span title=x\u0085[[shown]]>label</span>", set()),
        ("text <span title=x\u001c[[shown]]>label</span>", set()),
        ('text <span\ufefftitle="[[hidden]]">[[shown]]</span>', {"shown"}),
        ("text <a ? [[shown]]>label</a>", {"shown"}),
        ('text <a title="unclosed [[shown]]>label</a>', {"shown"}),
        (r'text \<a title="[[shown]]">label</a>', {"shown"}),
        ('`text <a title="[[hidden]]">[[hidden]]</a>` [[shown]]', {"shown"}),
        ('- text <a title="[[hidden]]">[[shown]]</a>', {"shown"}),
        ('> text <a title="[[hidden]]">[[shown]]</a>', {"shown"}),
        ('| h |\n| - |\n| text <a title="[[hidden]]">[[shown]]</a> |', {"shown"}),
    ],
)
def test_inline_html_metadata_scope(body: str, expected: set[str]) -> None:
    prose = prose_links(body)
    assert {
        match.group(1)
        for match in LINK_RE.finditer(prose)
        if not _markdown_escaped(prose, match.start())
    } == expected


def test_inline_html_metadata_preserves_source_history_and_real_edges(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "shown"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        '# Metadata boundary\r\n\r\nSee <a href="https://example.test/docs" '
        'title="[[hidden]] > notes">documentation</a> and [[shown|Companion]].\r\n'
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["excerpt"] == "See documentation and Companion."
    assert store.backlinks("hidden")["total"] == 0
    assert store.backlinks("shown")["total"] == 1
    assert store.graph()["missing_targets"] == []
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    store.save_page("source", markdown + "\r\n[[hidden]]", saved["revision"], "next")
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 1
    assert reopened.backlinks("shown")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
