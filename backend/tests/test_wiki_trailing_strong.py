"""One trailing plain strong segment inside single-star URL emphasis.

Static targets were checked with the frontend Marked12 extension. This does
not promise arbitrary nested emphasis, punctuation or Unicode strong contents.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize(
    "markdown,targets",
    [
        ("*HTTPS://example.test/[[hidden]] **plain*** [[shown]]", {"shown"}),
        ("prefix *HTTPS://example.test/[[hidden]] **plain*** [[shown]]", {"shown"}),
        ("\\*HTTPS://example.test/[[hidden]] **plain*** [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] **plain***` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] **plain***</a> [[shown]]',
            {"shown", "hidden"},
        ),
        ("*HTTPS://example.test/[[hidden]] tail **plain text*** [[shown]]", {"shown"}),
        ("prefix *HTTPS://example.test/[[hidden]] tail **plain text*** [[shown]]", {"shown"}),
        ("\\*HTTPS://example.test/[[hidden]] tail **plain text*** [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] tail **plain text***` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] tail **plain text***</a> [[shown]]',
            {"shown", "hidden"},
        ),
        ("*HTTPS://example.test/[[hidden]] **plain *** [[shown]]", {"shown", "hidden"}),
        ("prefix *HTTPS://example.test/[[hidden]] **plain *** [[shown]]", {"shown", "hidden"}),
        ("\\*HTTPS://example.test/[[hidden]] **plain *** [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] **plain ***` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] **plain ***</a> [[shown]]',
            {"shown", "hidden"},
        ),
        ("*HTTPS://example.test/[[hidden]] **plain** * [[shown]]", {"shown", "hidden"}),
        ("prefix *HTTPS://example.test/[[hidden]] **plain** * [[shown]]", {"shown", "hidden"}),
        ("\\*HTTPS://example.test/[[hidden]] **plain** * [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] **plain** *` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] **plain** *</a> [[shown]]',
            {"shown", "hidden"},
        ),
        ("\\*HTTPS://example.test/[[hidden]] **plain***word [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] **plain***word` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] **plain***word</a> [[shown]]',
            {"shown", "hidden"},
        ),
        ("\\*HTTPS://example.test/[[hidden]] **plain**** [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] **plain****` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] **plain****</a> [[shown]]',
            {"shown", "hidden"},
        ),
        ("*HTTPS://example.test/[[hidden]] **plain*** [[shown]] [[shown]]", {"shown"}),
        ("prefix *HTTPS://example.test/[[hidden]] **plain*** [[shown]] [[shown]]", {"shown"}),
        ("\\*HTTPS://example.test/[[hidden]] **plain*** [[shown]] [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] **plain*** [[shown]]` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] **plain*** [[shown]]</a> [[shown]]',
            {"shown", "hidden"},
        ),
        ("*HTTPS://example.test/[[hidden]] **plain***\nword [[shown]]", {"shown"}),
        ("prefix *HTTPS://example.test/[[hidden]] **plain***\nword [[shown]]", {"shown"}),
        ("\\*HTTPS://example.test/[[hidden]] **plain***\nword [[shown]]", {"shown"}),
        ("`*HTTPS://example.test/[[hidden]] **plain***\nword` [[shown]]", {"shown"}),
        (
            '<a href="/">*HTTPS://example.test/[[hidden]] **plain***\nword</a> [[shown]]',
            {"shown", "hidden"},
        ),
    ],
)
def test_trailing_strong_url_scope(markdown: str, targets: set[str]) -> None:
    pages = [{"id": key, "title": key, "markdown": ""} for key in ("hidden", "shown")]
    pages.append({"id": "source", "title": "Source", "markdown": markdown})
    graph = WikiStore._graph(pages, "synthetic-revision")
    assert {edge["target"] for edge in graph["edges"]} == targets


def test_nested_url_keeps_source_history_and_deliberate_edges(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for key in ("hidden", "shown"):
        store.save_page(key, f"# {key}", None, key)
    markdown = "# Nested URL\r\n\r\n*HTTPS://example.test/[[hidden]] **Field note*** [[shown]]\r\n"
    saved = store.save_page("source", markdown, None, "source")
    reopened = WikiStore(tmp_path)
    page = reopened.get_page("source")
    assert page is not None
    assert page["markdown"] == markdown
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    changed = markdown + "\r\n[[hidden|Deliberate connection]]\r\n"
    reopened.save_page("source", changed, saved["revision"], "deliberate")
    current = WikiStore(tmp_path)
    assert current.backlinks("hidden")["total"] == 1
    assert len(current.history("source")) == 2
    assert current._git("show", "HEAD~1:pages/source.md") == markdown.encode()
