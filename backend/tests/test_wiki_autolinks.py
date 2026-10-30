"""Bounded URL token cases compared with the installed frontend Marked12 extension."""

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
    "markdown,expected",
    [
        ("text <a>https://x.test/[[hidden]]</a>", set()),
        ('text <a href="/">x</a >https://x.test/[[shown]]', {"shown"}),
        ('text <a href="/"> <custom:record/[[hidden]]> </a>', set()),
        ("https://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("prefixhttps://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("www.example.test/[[hidden]] [[shown]]", {"shown"}),
        ("ftp://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("<https://example.test/[[hidden]]> [[shown]]", {"shown"}),
        ("<custom:record/[[hidden]]> [[shown]]", {"shown"}),
        ("<x:record/[[shown]]>", {"shown"}),
        ("https://example.test/(unclosed/[[shown]]", {"shown"}),
        ("https://example.test/(closed/[[hidden]]) [[shown]]", {"shown"}),
        ("https://example.test/[[hidden]]). [[shown]]", {"shown"}),
        ("https://example.test/[[hidden]]&amp; [[shown]]", {"shown"}),
        ("https://example.test/<[[shown]]>", {"shown"}),
        ("[[shown]]https://example.test/[[hidden]]", {"shown"}),
        ("`https://example.test/[[hidden]]` [[shown]]", {"shown"}),
        ("https://example.test/`[[hidden]]` [[shown]]", {"shown"}),
        ("**https://example.test/[[hidden]]** [[shown]]", {"shown"}),
        ("> https://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("- https://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("a | b\n--- | ---\nhttps://example.test/[[hidden]] | [[shown]]", {"shown"}),
        ("[label [[shown]]](https://example.test/[[hidden]])", {"shown"}),
        ("text <a href='/'>https://example.test/[[shown]]</a>", {"shown"}),
        ("HTTPS://example.test/[[hidden]] [[shown]]", {"shown"}),
        ("prefix HTTPS://example.test/[[shown]]", {"shown"}),
        ("**HTTPS://example.test/[[hidden]]**", set()),
        ("__HTTPS://example.test/[[hidden]]__", set()),
        ("prefix **HTTPS://example.test/[[hidden]]**", set()),
        ("prefix __HTTPS://example.test/[[hidden]]__ suffix", set()),
        ("**HTTPS://example.test/[[hidden]]** suffix", set()),
        ("mehr Wörter\t**HTTPS://example.test/[[hidden]]** nächste Wörter", set()),
        ("prefix **HTTPS://example.test/(unclosed/[[shown]]**", {"shown"}),
        ("prefix **HTTPS://example.test/[[shown]]**word", {"shown"}),
        ("prefix <a href='/'>**HTTPS://example.test/[[shown]]**</a>", {"shown"}),
        (r"prefix \**HTTPS://example.test/[[shown]]**", {"shown"}),
        ("**HTTPS://example.test/(unclosed/[[shown]]**", {"shown"}),
        ("word__HTTPS://example.test/[[shown]]__", {"shown"}),
        ("__HTTPS://example.test/[[shown]]__word", {"shown"}),
        ("**HTTPS://example.test/[[shown]]", {"shown"}),
        ("**HTTPS://example.test/[[shown]]**word", {"shown"}),
        ("*HTTPS://example.test/[[shown]]**!", {"shown"}),
        ("~*HTTPS://example.test/[[shown]]~*", {"shown"}),
        (r"\`*HTTPS://example.test/[[shown]]*`", {"shown"}),
        ("\\<custom:record/[[shown]]>", {"shown"}),
        ("[[https://example.test/target|shown]]", {"https://example.test/target"}),
        ("https://example.test/[[hidden]]\n\n[[shown]]", {"shown"}),
    ],
)
def test_url_navigation_scope(markdown: str, expected: set[str]) -> None:
    prose = prose_links(markdown)
    assert {
        m.group(1)
        for m in LINK_RE.finditer(prose)
        if m.group(1).strip() and not _markdown_escaped(prose, m.start())
    } == expected


def test_urls_remain_excerpt_text_without_becoming_graph_edges(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "shown"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "# URL boundary\r\n\r\n**HTTPS://example.test/[[hidden]]**\r\n\r\n"
        "prefix HTTPS://example.test/[[shown]]\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert "HTTPS://example.test/" in saved["excerpt"]
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    reopened.save_page("source", markdown + "\r\n[[hidden]]", saved["revision"], "next")
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()


def test_excerpt_keeps_visible_url_text() -> None:
    assert "https://example.test/" in plain_text_excerpt("https://example.test/[[visible]]")


def test_surrounding_words_keep_source_history_and_excerpts(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "shown"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "# Surrounding words\r\n\r\n"
        "prefix **HTTPS://example.test/[[hidden]]** suffix\r\n\r\n"
        "prefix HTTPS://example.test/[[shown]]\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert "prefix HTTPS://example.test/" in saved["excerpt"]
    assert "suffix" in saved["excerpt"]
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    reopened.save_page("source", markdown + "\r\n[[hidden]]", saved["revision"], "next")
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()


@pytest.mark.parametrize("delimiter", ["*", "_", "***", "___"])
@pytest.mark.parametrize(
    "prefix,suffix", [("", ""), ("prefix ", ""), ("mehr Wörter\t", " nächste Wörter")]
)
def test_single_and_triple_emphasis_urls_are_not_wiki_edges(
    delimiter: str, prefix: str, suffix: str
) -> None:
    markdown = f"{prefix}{delimiter}HTTPS://example.test/[[hidden]]{delimiter}{suffix}"
    prose = prose_links(markdown)
    assert not list(LINK_RE.finditer(prose))
    assert "HTTPS://example.test/" in plain_text_excerpt(markdown)


@pytest.mark.parametrize("delimiter", ["*", "_", "***", "___"])
def test_emphasis_url_projection_preserves_content_and_deliberate_link(
    tmp_path: Path, delimiter: str
) -> None:
    store = WikiStore(tmp_path)
    store.save_page("target", "# Target", None, "target")
    markdown = (
        f"# Emphasized URL\r\n\r\nwords {delimiter}"
        f"HTTPS://example.test/[[target]]{delimiter} remain\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert store.backlinks("target")["total"] == 0
    assert "HTTPS://example.test/" in saved["excerpt"]
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    revised = markdown + "\r\n[[target|Deliberate connection]]"
    store.save_page("source", revised, saved["revision"], "edit")
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("target")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()


@pytest.mark.parametrize("delimiter", ["*", "**", "***", "_", "__", "___"])
@pytest.mark.parametrize("suffix", ["!", " [[shown]]", "! [[shown]] suffix."])
def test_bounded_emphasis_url_punctuation_and_wiki_suffix(delimiter: str, suffix: str) -> None:
    markdown = f"prefix {delimiter}HTTPS://example.test/[[hidden]]{delimiter}{suffix}"
    expected = {"shown"} if "[[shown]]" in suffix else set()
    assert {m.group(1) for m in LINK_RE.finditer(prose_links(markdown))} == expected
    assert "HTTPS://example.test/" in plain_text_excerpt(markdown)


@pytest.mark.parametrize("delimiter", ["*", "**", "***"])
def test_asterisk_url_emphasis_can_open_inside_word(delimiter: str) -> None:
    markdown = f"word{delimiter}HTTPS://example.test/[[hidden]]{delimiter} [[shown]]"
    assert {m.group(1) for m in LINK_RE.finditer(prose_links(markdown))} == {"shown"}


def test_emphasis_url_suffix_preserves_exact_source_and_deliberate_edges(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "shown"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        "# Scoped URL\r\n\r\nword**HTTPS://example.test/[[hidden]]**\r\n\r\n"
        "*HTTPS://example.test/[[hidden]]*! [[shown|Visible]]\r\n"
    )
    saved = store.save_page("source", markdown, None, "first")
    assert "HTTPS://example.test/" in saved["excerpt"]
    reopened = WikiStore(tmp_path)
    assert reopened.backlinks("hidden")["total"] == 0
    assert reopened.backlinks("shown")["total"] == 1
    assert reopened._git("show", "HEAD:pages/source.md") == markdown.encode()
    reopened.save_page("source", markdown + "\r\n[[hidden]]", saved["revision"], "next")
    assert reopened.backlinks("hidden")["total"] == 1
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
