import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.index_config import configured_indexes
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiError, WikiStore


@pytest.mark.parametrize(
    "prefix",
    [
        "```markdown\n# Example heading\n```\n\n",
        "~~~~text\n# Example heading\n~~~\n# Still an example\n~~~~\n\n",
        "<!--\n# Example heading\n-->\n\n",
        "<!--\n```\n# Example heading\n-->\n\n",
        "```html <!--\n# Example heading\n```\n\n",
        "~~~html <!--\n# Example heading\n~~~\n\n",
        "<!-- comment -->```\n",
        "<!-- comment --># Example heading\n\n",
        "    # Example heading\n\n",
        "    <!-- code, not an open prose comment\n\n",
        "---\nlabel: example\n# Example heading\n---\n\n",
    ],
)
@pytest.mark.parametrize("indent", ["", " ", "  ", "   "])
def test_page_title_ignores_non_prose_headings(tmp_path: Path, prefix: str, indent: str) -> None:
    store = WikiStore(tmp_path)
    markdown = prefix + indent + "# Actual heading\nA fictional article.\n"
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


def test_inline_comment_cannot_hide_an_unclosed_code_fence(tmp_path: Path) -> None:
    # Installed Marked lexes the incomplete inline opener as literal text and
    # the following unclosed fence through EOF, including the apparent H1s.
    store = WikiStore(tmp_path)
    markdown = (
        "An introduction <!--\n~~~~\n# Example heading\n-->\n\n"
        "# Actual heading\nA fictional article.\n"
    )
    saved = store.save_page("article", markdown, None, "article")
    assert saved["title"] == "article"
    assert saved["excerpt"] == "An introduction <!--"
    assert saved["markdown"] == markdown
    reopened = WikiStore(store.path)
    assert reopened.get_page("article") == store.get_page("article")
    assert reopened._git("show", "HEAD:pages/article.md") == markdown.encode()


def test_code_only_heading_falls_back_to_id_and_inline_title_bytes_remain(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    code = "```md\n# Not a title\n```\n<!--\n# Neither is this\n-->\n"
    assert store.save_page("code-only", code, None, "code")["title"] == "code-only"
    literal = "# Actual `inline code` and **formatting**\nText."
    assert (
        store.save_page("literal", literal, None, "literal")["title"]
        == "Actual `inline code` and **formatting**"
    )


def test_unclosed_comments_hide_headings_but_code_comment_literals_remain(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    assert (
        store.save_page("unclosed", "<!--\n# Hidden\n[[missing]]", None, "u")["title"] == "unclosed"
    )
    assert store.graph()["missing_targets"] == []
    literal = "# Actual `<!-- literal -->` title\n\n```md\n<!--\n```\n\n[[actual]]"
    assert (
        store.save_page("literal", literal, None, "l")["title"] == "Actual `<!-- literal -->` title"
    )
    assert store.graph()["missing_targets"] == [{"source": "literal", "target": "actual"}]


@pytest.mark.parametrize(
    "old_schema",
    [
        "managed-snapshots-v1",
        "managed-snapshots-v2",
        "managed-snapshots-v3",
        "managed-snapshots-v4",
        "managed-snapshots-v5",
        "managed-snapshots-v6",
        "managed-snapshots-v7",
        "managed-snapshots-v8",
        "managed-snapshots-v9",
        "managed-snapshots-v10",
        "managed-snapshots-v19",
        "managed-snapshots-v20",
        "managed-snapshots-v21",
        "managed-snapshots-v22",
        "managed-snapshots-v23",
        "managed-snapshots-v24",
        "managed-snapshots-v27",
        "managed-snapshots-v28",
        "managed-snapshots-v29",
        "managed-snapshots-v30",
        "managed-snapshots-v31",
        "managed-snapshots-v32",
    ],
)
def test_title_projection_upgrade_invalidates_ready_index_receipts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    old_schema: str,
) -> None:
    # Use the real coordinator and durable SQLite ledger; the provider is an
    # in-memory adapter, so this is not a hosted Neo4j/Qdrant acceptance test.
    monkeypatch.delenv("SECOND_BRAIN_WIKI_GRAPH_INDEX", raising=False)
    monkeypatch.delenv("SECOND_BRAIN_WIKI_VECTOR_INDEX", raising=False)
    store = WikiStore(tmp_path)
    store.save_page("article", "```md\n# Example\n```\n\n   # Actual\nText.", None, "a")
    store.save_page("source", "# Source\n[[Actual]]", None, "s")
    revision = store._head()

    class GraphAdapter:
        def __init__(self) -> None:
            self.snapshots: list[dict[str, Any]] = []

        def build(self, generation: str, snapshot: dict[str, Any]) -> None:
            self.snapshots.append(snapshot)

        def neighbors(self, generation: str, seeds: list[str], hops: int, limit: int) -> list[str]:
            return ["source", "article"]

    adapter = GraphAdapter()
    old_config = hashlib.sha256(
        json.dumps({"schema": old_schema}, sort_keys=True).encode()
    ).hexdigest()
    previous = IndexCoordinator(store, {"graph": adapter}, config_id=old_config)
    assert previous.run_once()["indexes"]["graph"]["state"] == "current"
    upgraded = configured_indexes(store)
    upgraded.adapters["graph"] = adapter
    assert upgraded.config_id != old_config
    assert upgraded.status()["indexes"]["graph"]["state"] == "pending"
    with pytest.raises(WikiError) as failure:
        upgraded.neighbors(["source"])
    assert failure.value.code == "index_pending"
    assert len(adapter.snapshots) == 1
    assert upgraded.run_once()["indexes"]["graph"]["state"] == "current"
    assert len(adapter.snapshots) == 2
    assert adapter.snapshots[-1]["graph"]["edges"] == [
        {"source": "source", "target": "article", "type": "wikilink"}
    ]
    assert {page["id"] for page in upgraded.neighbors(["source"])["pages"]} == {
        "source",
        "article",
    }
    assert (
        next(p for p in adapter.snapshots[-1]["pages"] if p["id"] == "article")["title"] == "Actual"
    )
    assert store._head() == revision


@pytest.mark.parametrize(
    "prefix",
    [
        "- # Listed title\n\n",
        "1. # Listed title\n\n",
        "- Parent\n  - # Listed title\n\n",
        "> # Quoted title\n\n",
        "| # Cell title | x |\n| --- | --- |\n\n",
        "x | # Cell title\n--- | ---\n\n",
        "\t# Code title\n\n",
        "    # Code title\n\n",
    ],
)
def test_indented_title_keeps_container_provenance(tmp_path: Path, prefix: str) -> None:
    store = WikiStore(tmp_path)
    markdown = prefix + "Outside the container.\n\n   # First actual title\n\n# Later title\n"
    saved = store.save_page("article", markdown, None, "a")
    assert saved["title"] == "First actual title"
    assert saved["markdown"] == markdown
    assert store._git("show", "HEAD:pages/article.md") == markdown.encode()


@pytest.mark.parametrize(
    "markdown, title",
    [
        ("#\nFollowing paragraph\n", "article"),
        ("#  \t\nFollowing paragraph\n", "article"),
        ("   # EOF title", "EOF title"),
        ("# \nFollowing paragraph\n", "article"),
        ("# \n# Real title\n", "Real title"),
        ("#\u00a0Not an ATX heading\n", "article"),
        ("#\tTab title\rBody\r", "Tab title"),
        ("  # CR title\r\nBody\r\n", "CR title"),
    ],
)
def test_title_uses_horizontal_ascii_heading_boundary(
    tmp_path: Path, markdown: str, title: str
) -> None:
    store = WikiStore(tmp_path)
    saved = store.save_page("article", markdown, None, "a")
    assert saved["title"] == title
    assert saved["markdown"] == markdown


@pytest.mark.parametrize(
    "markdown",
    [
        "- # Listed title\n\n   # Still listed\n",
        "1. # Listed title\n\n   # Still listed\n",
        "> # Quoted title\n",
        "    # Code title\n",
        "\t# Code title\n",
    ],
)
def test_contained_headings_never_become_page_identity(tmp_path: Path, markdown: str) -> None:
    store = WikiStore(tmp_path)
    assert store.save_page("article", markdown, None, "a")["title"] == "article"
