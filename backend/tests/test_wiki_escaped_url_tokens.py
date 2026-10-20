"""Escaped ASCII punctuation ends Marked12's inline text run.

Static targets were checked against the frontend tokenizer. Complex nested
emphasis parity is deliberately outside this bounded regression matrix.
"""

from pathlib import Path

import pytest

from second_brain.wiki import store as wiki_store
from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize(
    "markdown,targets",
    [
        ("\\!HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\*HtTp://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\*FTP://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\*WwW.example.test/[[hidden]] [[shown]]", {"shown"}),
        ('\\"HTTPS://example.test/[[hidden]] [[shown]]', {"shown"}),
        ("\\#HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\$HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\%HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\&HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\'HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\(HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\)HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\*HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\+HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\,HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\-HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\.HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\/HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\:HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\;HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\<HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\=HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\>HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\?HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\@HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\[HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\\\HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\]HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\^HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\_HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\`HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\{HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\|HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\}HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\~HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\aHTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\ HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\*HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\_HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\<HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\[HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\aHTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\ HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\*HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\\\\\_HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\\\\\<HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\\\\\[HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("\\\\\\aHTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\ HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\\\*HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\\\_HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\\\<HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\\\[HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\\\aHTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("\\\\\\\\ HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("prefix HTTPS://example.test/[[hidden]] [[shown]]", {"hidden", "shown"}),
        ("`\\*HTTPS://example.test/[[hidden]]` [[shown]]", {"shown"}),
        ('<a href="/">\\*HTTPS://example.test/[[hidden]]</a> [[shown]]', {"hidden", "shown"}),
        ('[label](/path "\\*HTTPS://example.test/[[hidden]]") [[shown]]', {"shown"}),
        ("[[shown|\\*HTTPS://example.test/[[hidden]]]]", {"shown"}),
        ("**\\*HTTPS://example.test/[[hidden]]** [[shown]]", {"shown"}),
        ("\\<HTTPS://example.test/[[hidden]]> [[shown]]", {"shown"}),
    ],
)
def test_escaped_punctuation_url_token(markdown: str, targets: set[str]) -> None:
    pages = [{"id": key, "title": key, "markdown": ""} for key in ("hidden", "shown")]
    pages.append({"id": "source", "title": "Source", "markdown": markdown})
    graph = WikiStore._graph(pages, "synthetic-revision")
    assert {edge["target"] for edge in graph["edges"]} == targets


def test_escape_url_keeps_source_history_and_deliberate_links(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for key in ("hidden", "shown"):
        store.save_page(key, f"# {key}", None, key)
    markdown = (
        "# Literal marker\r\n\r\n" + chr(92) + "*HTTPS://example.test/[[hidden]]* [[shown]]\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    assert reopened.get_page("source")["markdown"] == markdown
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    changed = markdown + "\r\n[[hidden|Deliberate connection]]\r\n"
    reopened.save_page("source", changed, saved["revision"], "deliberate")
    current = WikiStore(tmp_path)
    assert current.backlinks("hidden")["total"] == 1
    assert len(current.history("source")) == 2
    assert current._git("show", "HEAD~1:pages/source.md") == markdown.encode()


def test_non_urls_do_not_rescan_backslash_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0
    original = wiki_store._markdown_escaped

    def counted(text: str, position: int) -> bool:
        nonlocal calls
        calls += 1
        return original(text, position)

    monkeypatch.setattr(wiki_store, "_markdown_escaped", counted)
    text = chr(92) * 20_000 + "HTTPS://example.test/[[hidden]]"
    for position in range(20_001):
        wiki_store._autolink_end(text, position)
    assert calls == 1
