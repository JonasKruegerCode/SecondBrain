"""Exact inline code delimiters checked against installed Marked 12.0.2.

These tests cover delimiter recognition, not a general Markdown tokenizer or
paragraph-boundary changes. Source Markdown remains authoritative.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_links


@pytest.mark.parametrize(
    "markdown,visible",
    [
        (r"Use \` [[target]] \` today.", {"target"}),
        (r"Use \\\` [[target]] \` today.", {"target"}),
        (r"Use \\` [[hidden]] ` today.", set()),
        (r"Use ` [[hidden]] \` today.", set()),
        (r"Use \` [[target]] \` and `[[hidden]]`.", {"target"}),
        ("Use `` [[target]] ` today.", {"target"}),
        ("Use ` [[target]] `` today.", {"target"}),
        ("Use `` before ` [[hidden]] ` after `` [[target]].", {"target"}),
        ("Use `one `` [[hidden]] `` two` [[target]].", {"target"}),
        # Escaping one tick leaves the remaining run available as an opener.
        (r"Use \`` [[hidden]] ` [[target]].", {"target"}),
        # A tick inside a comment cannot consume the later actual code opener.
        ("Use <!-- ` --> `[[hidden]]` [[target]].", {"target"}),
        (r"Use \` <!-- [[hidden]] --> [[target]] \`.", {"target"}),
        ("Use `` <!-- [[hidden]] --> `` [[target]].", {"target"}),
        # Unequal runs do not shield comments as though they were code.
        ("Use `` <!-- [[hidden]] --> ` [[target]].", {"target"}),
    ],
)
def test_inline_code_recognizes_escapes_and_exact_runs(markdown: str, visible: set[str]) -> None:
    assert {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))} == visible


def test_literal_backticks_preserve_graph_backlinks_excerpt_and_source(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("target", "# Target", None, "target")
    store.save_page("hidden", "# Hidden", None, "hidden")
    markdown = "# Source\r\n\r\n" + r"Use \` [[target|companion]] \` and `[[hidden]]`."
    saved = store.save_page("source", markdown, None, "source")
    assert saved["markdown"] == markdown
    assert "companion" in saved["excerpt"]
    assert "hidden" not in saved["excerpt"]
    assert store.graph()["edges"] == [
        {"source": "source", "target": "target", "type": "wikilink"}
    ]
    assert store.backlinks("target")["total"] == 1
    assert store.backlinks("hidden")["total"] == 0
    reopened = WikiStore(tmp_path).get_page("source")
    assert reopened is not None
    assert reopened["markdown"] == markdown
    changed = "# Changed\r\n\r\n[[hidden]]\r\n"
    store.save_page("source", changed, saved["revision"], "changed")
    updated = WikiStore(tmp_path)
    assert updated.backlinks("target")["total"] == 0
    assert updated.backlinks("hidden")["total"] == 1
    assert len(updated.history("source")) == 2
    assert updated._git("show", "HEAD:pages/source.md") == changed.encode()
    assert updated._git("show", "HEAD~1:pages/source.md") == markdown.encode()
