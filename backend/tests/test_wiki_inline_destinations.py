"""Bounded inline destination/title cases checked against installed Marked12."""

from pathlib import Path

import pytest

from second_brain.wiki.store import (
    LINK_RE,
    WikiStore,
    _markdown_escaped,
    plain_text_excerpt,
    prose_links,
)


@pytest.mark.parametrize(
    "body,expected",
    [
        ("[external](https://example.test/[[hidden]])", set()),
        ("![[hidden]](url)", set()),
        ("![[hidden|alias]](url)", set()),
        ('[[ ]](url "[[hidden]]")', set()),
        ('[text](url/[[hidden]] "title [[hidden2]]") [[shown]]', {"shown"}),
        ("[text](url/[[hidden]] 'title [[hidden2]]') [[shown]]", {"shown"}),
        ("[text](url/[[hidden]] (title [[hidden2]])) [[shown]]", {"shown"}),
        ("[text](url(a(b))/[[hidden]]) [[shown]]", {"shown"}),
        ("[text](url\\)/[[hidden]]) [[shown]]", {"shown"}),
        ("[text](url/[[hidden]])tail/[[shown]]", {"shown"}),
        ("[text](<url/[[hidden]]>) [[shown]]", {"shown"}),
        ('[text](url "title\n[[hidden]]")\n[[shown]]', {"shown"}),
        ("[text]\n(url/[[shown]])", {"shown"}),
        ('[text](url/[[hidden]] "unclosed) [[shown]]', {"shown", "hidden"}),
        ("[text](<url/[[hidden]]\\>) [[shown]]", {"shown", "hidden"}),
        ("\\[text](url/[[shown]])", {"shown"}),
        ("\\\\[text](url/[[hidden]]) [[shown]]", {"shown"}),
        ("`[text](url/[[hidden]])` [[shown]]", {"shown"}),
        ("[text](url/`[[hidden]])` [[shown]]", {"shown"}),
        ("[label `[[hidden]]`](url/[[hidden2]]) [[shown]]", {"shown"}),
        ('![label](url/[[hidden]] "title [[hidden2]]") [[shown]]', {"shown"}),
        ("[label [nested]](url/[[hidden]]) [[shown]]", {"shown"}),
        ("[label [[shown]]](relative/[[also]])", {"shown", "also"}),
        ("[[shown]](relative/[[also]])", {"shown", "also"}),
        ("> [text](url/[[hidden]]) [[shown]]", {"shown"}),
        ("- [text](url/[[hidden]]) [[shown]]", {"shown"}),
        ("a | b\n--- | ---\n[text](url/[[hidden]]) | [[shown]]", {"shown"}),
        ('[text](url/[[hidden]] "code `") [[shown]] `', {"shown"}),
    ],
)
def test_inline_destination_prose_scope(body: str, expected: set[str]) -> None:
    prose = prose_links(body)
    assert {
        m.group(1)
        for m in LINK_RE.finditer(prose)
        if m.group(1).strip() and not _markdown_escaped(prose, m.start())
    } == expected


def test_inline_metadata_preserves_source_history_and_backlinks(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "shown"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "# Actual\r\n\r\n[External source](https://example.test/[[hidden]] "
        '"title [[hidden]]")\r\n\r\n[[shown]]\r\n'
    )
    saved = store.save_page("source", markdown, None, "source")
    assert "hidden" not in saved["excerpt"]
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    current = reopened.get_page("source")
    assert current is not None
    assert current["markdown"] == markdown
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    reopened.save_page("source", markdown + "\r\n[[hidden]]", saved["revision"], "next")
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()


def test_inline_labels_remain_readable_in_excerpts() -> None:
    assert (
        plain_text_excerpt(
            '[External source](url "[[hidden]]") ![Map illustration](image.png "[[hidden]]")'
        )
        == "External source Map illustration"
    )


def test_nested_image_alt_is_excerpt_text_only() -> None:
    assert plain_text_excerpt('![[hidden]](url "[[metadata]]")') == "[hidden]"
