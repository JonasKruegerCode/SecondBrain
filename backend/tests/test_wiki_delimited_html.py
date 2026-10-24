"""Delimited HTML block expectations verified with installed Marked 12.

Lexical Markdown boundaries only: sanitized browser DOM is a separate concern.
"""

from pathlib import Path

import pytest

from second_brain.wiki.store import LINK_RE, WikiStore, prose_blocks, prose_links

FORMS = [("pi", "<?synthetic", "?>"), ("declaration", "<!A", ">"), ("cdata", "<![cDaTa[", "]]>")]


def targets(markdown: str) -> set[str]:
    return {match.group(1) for match in LINK_RE.finditer(prose_links(markdown))}


@pytest.mark.parametrize("name,opening,closing", FORMS, ids=[row[0] for row in FORMS])
@pytest.mark.parametrize("shape", ["closed", "eof", "suffix", "crlf"])
def test_delimited_html_blocks_hide_only_their_lexical_body(
    name: str, opening: str, closing: str, shape: str
) -> None:
    markdown = f"   {opening}\n# Ghost\n[[hidden]]\n\n[[absent]]\n"
    if shape != "eof":
        markdown += closing + ("[[after]]" if shape == "suffix" else "")
        markdown += "\n# Real\n\n[[visible]]"
    if shape == "crlf":
        markdown = markdown.replace("\n", "\r\n")
    assert targets(markdown) == (
        set() if shape == "eof" else {"visible", "after"} if shape == "suffix" else {"visible"}
    )
    projected = prose_blocks(markdown)
    assert "# Ghost" not in projected
    assert ("# Real" in projected) == (shape != "eof")


@pytest.mark.parametrize("name,opening,closing", FORMS, ids=[row[0] for row in FORMS])
@pytest.mark.parametrize("container", ["quote", "list"])
def test_delimited_html_inside_containers(
    name: str, opening: str, closing: str, container: str
) -> None:
    body = f"{opening}\n[[hidden]]\n\n[[absent]]\n{closing}\n[[visible]]"
    if container == "quote":
        markdown = "\n".join("> " + line for line in body.splitlines())
    else:
        markdown = "- Container\n" + "\n".join("  " + line for line in body.splitlines())
    assert targets(markdown) == {"visible"}


@pytest.mark.parametrize("name,opening,closing", FORMS, ids=[row[0] for row in FORMS])
def test_delimited_forms_do_not_interrupt_paragraphs_or_tables(
    name: str, opening: str, closing: str
) -> None:
    # The heading ends the paragraph before an inline HTML token could close.
    paragraph = f"text\n{opening}\n# Real\n[[visible]]\n{closing}"
    assert targets(paragraph) == {"visible"}
    assert "# Real" in prose_blocks(paragraph)
    # Each table cell is parsed inline independently; an incomplete opener is text.
    table = f"a | b\n--|--\n{opening}\n[[visible]]\n{closing}"
    assert targets(table) == {"visible"}


@pytest.mark.parametrize(
    "prefix",
    [
        "```html\n<?synthetic\n```\n\n",
        "    <!A\n\n",
        "\\<?synthetic\n\n",
        "<!1\n\n",
        "<![CDATAx[\n\n",
        "<!Ä\n\n",
    ],
)
def test_code_escaped_and_invalid_openers_preserve_later_prose(prefix: str) -> None:
    markdown = prefix + "# Real\n\n[[visible]]"
    assert targets(markdown) == {"visible"}
    assert "# Real" in prose_blocks(markdown)


@pytest.mark.parametrize("name,opening,closing", FORMS, ids=[row[0] for row in FORMS])
def test_delimited_html_store_preserves_source_and_publishes_only_prose(
    tmp_path: Path, name: str, opening: str, closing: str
) -> None:
    store = WikiStore(tmp_path)
    for target in ("hidden", "visible"):
        store.save_page(target, f"# {target}", None, target)
    markdown = (
        f"{opening}\r\n# Ghost\r\n[[hidden]]\r\n[[absent]]\r\n{closing}\r\n"
        "# Real\r\n\r\nVisible [[visible|companion]].\r\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "Real"
    assert saved["excerpt"] == "Visible companion."
    assert saved["markdown"] == markdown
    assert store._git("show", "HEAD:pages/source.md") == markdown.encode()
    assert store.snapshot()["graph"]["edges"] == [
        {"source": "source", "target": "visible", "type": "wikilink"}
    ]
    assert store.graph()["missing_targets"] == []
    assert store.backlinks("hidden")["total"] == 0
    assert store.backlinks("visible")["total"] == 1
    store.save_page("source", "# Changed\n\n[[hidden]]", saved["revision"], "changed")
    reopened = WikiStore(store.path)
    assert reopened.backlinks("hidden")["total"] == 1
    assert reopened.backlinks("visible")["total"] == 0
    assert len(reopened.history("source")) == 2
    assert reopened._git("show", "HEAD~1:pages/source.md") == markdown.encode()
    current = reopened.get_page("source")
    assert current is not None
    assert current["title"] == "Changed"


@pytest.mark.parametrize("name,opening,closing", FORMS, ids=[row[0] for row in FORMS])
@pytest.mark.parametrize("spaces", [0, 3, 4])
def test_closing_suffix_does_not_reexpand_originally_internal_tabs(
    name: str, opening: str, closing: str, spaces: int
) -> None:
    markdown = f"{opening}\n[[hidden]]\n{closing}" + " " * spaces + "\t[[after]]\n[[visible]]"
    assert targets(markdown) == ({"visible"} if spaces == 4 else {"after", "visible"})
    suffix = f"{opening}{closing}\t# Fake"
    assert WikiStore._page("source", suffix.encode(), "synthetic")["title"] == "source"
