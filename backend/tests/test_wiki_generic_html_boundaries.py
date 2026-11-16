"""Literal expectations checked against Marked 12 and the frontend wikilink extension.

These are HTML block boundaries, not browser DOM or HTML sanitization tests.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_links

HTML_CASES = [
    ("block-body", "<div>\n[[x]]\n\n[[y]]", {"y"}),
    ("block-two-spaces", "<div>\n  [[x]]\n\n[[y]]", {"y"}),
    ("standalone-body", "<custom>\n[[x]]\n\n[[y]]", {"y"}),
    ("standalone-code-indent", "<custom>\n    [[x]]\n\n[[y]]", {"y"}),
    ("closing-standalone", "</custom>\n[[x]]\n\n[[y]]", {"y"}),
    ("paragraph-custom", "text\n<custom>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("paragraph-custom-deep", "text\n<custom>\n        [[x]]\n\n[[y]]", {"x", "y"}),
    ("paragraph-closing-custom", "text\n</custom>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("paragraph-block", "text\n<div>\n[[x]]\n\n[[y]]", {"y"}),
    ("paragraph-indented-block", "text\n  <div>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("blank-reset", "text\n\n<custom>\n[[x]]\n\n[[y]]", {"y"}),
    ("setext-reset", "text\n---\n<custom>\n[[x]]\n\n[[y]]", {"y"}),
    ("definition-reset", "[a]: /x\n<custom>\n[[x]]\n\n[[y]]", {"y"}),
    ("table-custom-row", "a | b\n--|--\n<custom>\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("table-code-boundary", "a | b\n--|--\n<custom>\n    [[x]]\n\n[[y]]", {"y"}),
    ("table-block-boundary", "a | b\n--|--\n<div>\n[[x]]\n\n[[y]]", {"y"}),
    ("table-indented-tag-row", "a | b\n--|--\n  <div>\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("list-lazy-custom", "- text\n<custom>\n    [[x]]\n\n[[y]]", {"y"}),
    ("list-lazy-block", "- text\n<div>\n    [[x]]\n\n[[y]]", {"y"}),
    ("wide-list-block", "123. <div>\n        [[x]]\n\n[[y]]", {"y"}),
    ("wide-list-custom", "123. <custom>\n        [[x]]\n\n[[y]]", {"y"}),
    ("block-tab-attribute", "<div\tclass=x>\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("custom-tab-attribute", "<custom\tclass=x>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("paragraph-tab-attribute", "text\n<div\tclass=x>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("list-tab-attribute", "- text\n<custom\tclass=x>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("malformed-attribute", "<custom bad=>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("quoted-attribute", '<custom a="x">\n[[x]]\n\n[[y]]', {"y"}),
    ("raw-prefix-not-type-seven", "<scripted>\n    [[x]]\n\n[[y]]", {"x", "y"}),
    ("closing-tag-not-end", "<div>\n</div>\n[[x]]\n\n[[y]]", {"y"}),
    ("blank-releases-body", "<div>\n\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("nbsp-not-blank", "<div>\n\u00a0\n[[x]]\n\n[[y]]", {"y"}),
    ("tab-blank", "<div>\n\t\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("non-one-paragraph", "text\n2. <div>\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("wide-number-paragraph", "text\n123. <div>\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("empty-number-paragraph", "text\n1.\n<custom>\n[[x]]\n\n[[y]]", {"x", "y"}),
    ("empty-star-paragraph", "text\n*\n<custom>\n[[x]]\n\n[[y]]", {"x", "y"}),
]


@pytest.mark.parametrize("name,markdown,expected", HTML_CASES, ids=[c[0] for c in HTML_CASES])
def test_generic_html_prose_targets(name: str, markdown: str, expected: set[str]) -> None:
    assert {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))} == expected


def test_html_projection_preserves_raw_history_and_publishes_only_prose(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("x", "y"):
        store.save_page(target, f"# {target}", None, target)
    markdown = "# Source\n\n123. <div>\n        [[x]]\n\n[[y]]"
    saved = store.save_page("source", markdown, None, "source")
    assert saved["markdown"] == markdown
    read = store.get_page("source")
    assert read is not None
    assert read["markdown"] == markdown
    assert read["title"] == "Source"
    assert read["excerpt"] == "y"
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    assert len(store.history("source")) == 1
    assert store.snapshot()["graph"]["edges"] == [
        {"source": "source", "target": "y", "type": "wikilink"}
    ]
    assert store.backlinks("x")["total"] == 0
    assert store.backlinks("y")["total"] == 1
    changed = "# Source\n\ntext\n<custom>\n    [[x]]\n\n[[y]]"
    store.save_page("source", changed, saved["revision"], "changed")
    reopened = WikiStore(store.path)
    assert reopened.backlinks("x")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
