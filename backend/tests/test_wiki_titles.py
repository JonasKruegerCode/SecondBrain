from pathlib import Path

import pytest

from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize(
    "prefix",
    [
        "```markdown\n# Example heading\n```\n\n",
        "~~~~text\n# Example heading\n~~~\n# Still an example\n~~~~\n\n",
        "<!--\n# Example heading\n-->\n\n",
        "    # Example heading\n\n",
        "---\nlabel: example\n# Example heading\n---\n\n",
    ],
)
def test_page_title_ignores_non_prose_headings(tmp_path: Path, prefix: str) -> None:
    store = WikiStore(tmp_path)
    markdown = prefix + "# Actual heading\nA fictional article.\n"
    saved = store.save_page("article", markdown, None, "article")
    assert saved["title"] == "Actual heading"
    assert saved["markdown"] == markdown
    read = store.get_page("article")
    assert read is not None
    assert read["title"] == saved["title"]
    assert read["markdown"] == markdown
    assert read["revision"] == saved["revision"]
    store.save_page(
        "source",
        "# Source\n[[Actual heading]] [[Example heading]]",
        None,
        "source",
    )
    assert store.search("Actual heading")[0]["id"] == "article"
    assert next(p for p in store.list_pages() if p["id"] == "article")["title"] == "Actual heading"
    resolved = store.resolve_links(["Actual heading", "Example heading"])["resolutions"]
    assert resolved[0]["candidates"] == [{"id": "article", "title": "Actual heading"}]
    assert resolved[1]["status"] == "missing"
    graph = store.graph()
    assert graph["edges"] == [{"source": "source", "target": "article", "type": "wikilink"}]
    assert graph["missing_targets"] == [{"source": "source", "target": "Example heading"}]
    assert store.backlinks("article")["total"] == 1
    assert len(store.history("article")) == 1


def test_code_only_heading_falls_back_to_id_and_inline_title_bytes_remain(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    code = "```md\n# Not a title\n```\n<!--\n# Neither is this\n-->\n"
    assert store.save_page("code-only", code, None, "code")["title"] == "code-only"
    literal = "# Actual `inline code` and **formatting**\nText."
    assert (
        store.save_page("literal", literal, None, "literal")["title"]
        == "Actual `inline code` and **formatting**"
    )
