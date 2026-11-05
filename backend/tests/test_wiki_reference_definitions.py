"""Bounded block-reference projection cases checked against installed Marked12."""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_links


@pytest.mark.parametrize(
    "body,expected",
    [
        ("[ref]: https://example.test/[[hidden]]", set()),
        ("[ref]: [[hidden]]", set()),
        ('[ref]: https://example.test "[[hidden]]"', set()),
        ("[ref]:\n    https://example.test/[[hidden]]", set()),
        ('[ref]: [[hidden]]\n    "title [[hidden2]]"\n[[shown]]', {"shown"}),
        ('[ref]: [[hidden]] "title\n\n[[hidden2]]"\n[[shown]]', {"shown"}),
        ("[ref]: [[hidden]] (title\n\n[[hidden2]])\n[[shown]]", {"shown"}),
        ("[ref]: [[hidden]] 'title\n\n[[shown]]'", {"hidden", "shown"}),
        ('[ref]: [[hidden]]\n"unclosed [[shown]]', {"shown"}),
        (r"[a\]b]: https://example.test/[[hidden]]", set()),
        ("[bad[label]]: [[shown]]", {"shown"}),
        ("[ref]: no spaces [[shown]]", {"shown"}),
        ("text\n[ref]: [[shown]]\n    [[also]]", {"shown", "also"}),
        ("> [ref]: [[hidden]]\n>\n> [[shown]]", {"shown"}),
        ("- [ref]: [[hidden]]\n\n  [[shown]]", {"shown"}),
        ("- text\n  [ref]: [[shown]]\n    [[also]]", {"shown", "also"}),
        ("a | b\n--- | ---\n[ref]: [[shown]] | cell", {"shown"}),
        ("<![CDATA[hidden]]>[ref]: [[hidden]]\n[[shown]]", {"shown"}),
    ],
)
def test_reference_definition_prose_scope(body: str, expected: set[str]) -> None:
    assert {m.group(1) for m in LINK_RE.finditer(prose_links(body))} == expected


def test_reference_metadata_preserves_content_history_and_real_backlinks(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "shown"):
        store.save_page(target, f"# {target}", None, target)
    markdown = '[ref]: [[hidden]] "title\r\n# False title\r\n"\r\n\r\n# Actual\r\n\r\n[[shown]]\r\n'
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "Actual"
    assert "hidden" not in saved["excerpt"]
    assert "False title" not in saved["excerpt"]
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    current = reopened.get_page("source")
    assert current is not None
    assert current["markdown"] == markdown
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    updated = reopened.save_page("source", markdown + "\r\n[[hidden]]", saved["revision"], "next")
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
    assert updated["revision"] != saved["revision"]
