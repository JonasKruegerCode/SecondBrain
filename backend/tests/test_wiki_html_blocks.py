from pathlib import Path

import pytest

from second_brain.wiki.store import WikiStore, prose_blocks


@pytest.mark.parametrize("tag", ["pre", "script", "style", "textarea"])
@pytest.mark.parametrize("shape", ["same-line", "split-line", "mixed-case", "unclosed"])
def test_raw_html_blocks_do_not_publish_markdown_evidence(
    tmp_path: Path, tag: str, shape: str
) -> None:
    store = WikiStore(tmp_path)
    store.save_page("hidden", "# Hidden target", None, "hidden")
    store.save_page("visible", "# Visible target", None, "visible")
    opening = tag.upper() if shape == "mixed-case" else tag
    closing = tag.title() if shape == "mixed-case" else tag
    if shape == "same-line":
        block = f"<{opening}>[[hidden]] [[absent]]</{closing}> [[closing-line-absent]]\n"
    else:
        block = (
            f'   <{opening} class="synthetic">\n'
            "# Example heading\n[[hidden]]\n\n[[absent]]\n"
            "```\n<!-- literal raw block text\n"
        )
        if shape != "unclosed":
            block += f"</{closing}> [[closing-line-absent]]\n"
    suffix = "" if shape == "unclosed" else "\n# Actual heading\n\nVisible [[visible|companion]].\n"
    markdown = block + suffix
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == ("source" if shape == "unclosed" else "Actual heading")
    assert saved["excerpt"] == ("" if shape == "unclosed" else "Visible companion.")
    assert saved["markdown"] == markdown
    assert (store.get_page("source") or {})["markdown"] == markdown
    graph = store.snapshot()["graph"]
    assert graph["edges"] == (
        []
        if shape == "unclosed"
        else [{"source": "source", "target": "visible", "type": "wikilink"}]
    )
    assert graph["missing_targets"] == []
    assert graph["ambiguous_targets"] == []
    assert store.backlinks("hidden")["total"] == 0
    assert store.backlinks("visible")["total"] == (0 if shape == "unclosed" else 1)


@pytest.mark.parametrize(
    "prefix",
    [
        "```html\n<pre>\n```\n\n",
        "~~~html\n<script>\n~~~\n\n",
        "<!--\n<style>\n-->\n\n",
        r"\<textarea>" + "\n\n",
        "Inline <pre> text\n\n",
        "<prelude>\n\n",
        "<ſcript>\n\n",
    ],
)
def test_fake_raw_html_openings_do_not_swallow_later_prose(tmp_path: Path, prefix: str) -> None:
    store = WikiStore(tmp_path)
    store.save_page("visible", "# Visible", None, "visible")
    markdown = prefix + "# Actual heading\n\nVisible [[visible]].\n"
    saved = store.save_page("source", markdown, None, "source")
    assert saved["title"] == "Actual heading"
    assert saved["markdown"] == markdown
    assert store.graph()["edges"] == [{"source": "source", "target": "visible", "type": "wikilink"}]
    assert store.backlinks("visible")["total"] == 1


def test_raw_html_closing_line_is_not_reparsed_as_markdown() -> None:
    assert prose_blocks("<pre>\nexample\n</pre> [[not-prose]]\n\n[[visible]]") == "\n[[visible]]"


@pytest.mark.parametrize("tag", ["pre", "script", "style", "textarea"])
def test_incomplete_raw_tag_needs_a_real_delimiter(tag: str) -> None:
    # Native Marked lexes the EOF form as a paragraph, but newline is an
    # opening delimiter even before an attribute or closing angle bracket.
    assert prose_blocks(f"<{tag}") == f"<{tag}"
    assert prose_blocks(f"<{tag}\n") == ""
    markdown = f'<{tag}\nclass="synthetic">\n[[hidden]]\n\n</{tag}>\n\n[[visible]]'
    assert prose_blocks(markdown).strip() == "[[visible]]"


def test_list_continuation_raw_html_matches_native_marked(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("hidden", "# Hidden", None, "hidden")
    store.save_page("visible", "# Visible", None, "visible")
    markdown = (
        "# Actual heading\n\n- Container\n\n"
        "  <pre>\n  [[hidden]]\n\n  [[absent]]\n  </pre>\n\n"
        "  Visible [[visible]].\n"
    )
    saved = store.save_page("source", markdown, None, "source")
    assert saved["markdown"] == markdown
    assert saved["title"] == "Actual heading"
    assert store.graph()["edges"] == [{"source": "source", "target": "visible", "type": "wikilink"}]
    assert store.graph()["missing_targets"] == []
    assert store.backlinks("hidden")["total"] == 0
    assert store.backlinks("visible")["total"] == 1
