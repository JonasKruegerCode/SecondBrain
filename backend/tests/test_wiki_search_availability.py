"""Search stays available during rebuilds and does bounded work per request."""

from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.search_service import search_wiki
from second_brain.wiki.store import WikiError, WikiStore


class Vectors:
    def __init__(self) -> None:
        self.generations: dict[str, list[dict[str, Any]]] = {}
        self.fail = False
        self.during_build: Any = None

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        self.generations[generation] = [
            {"id": page["id"], "revision": page["revision"], "score": 0.9}
            for page in snapshot["pages"]
        ]
        if self.during_build:
            self.during_build()
        if self.fail:
            raise RuntimeError("private provider failure")

    def search(self, generation: str, query: str, limit: int) -> list[dict[str, Any]]:
        return self.generations[generation][:limit]


def setup(tmp_path: Path) -> tuple[WikiStore, Vectors, IndexCoordinator]:
    store = WikiStore(tmp_path)
    store.save_page("tactics", "# Tactics\nA strategy game.", None, "seed")
    vectors = Vectors()
    indexes = IndexCoordinator(store, {"vector": vectors})
    indexes.run_once()
    return store, vectors, indexes


def test_search_serves_ready_generation_during_build_failure_and_restart(tmp_path: Path) -> None:
    store, vectors, indexes = setup(tmp_path)
    original = indexes._serving_receipt("vector")
    assert original
    store.save_page("other", "# Other\nA new page.", None, "other")
    during: list[dict[str, Any]] = []
    vectors.during_build = lambda: during.append(search_wiki(store, indexes, "zocken"))
    vectors.fail = True
    indexes.run_once()
    assert during[0]["mode"] == "semantic"
    assert during[0]["index_state"] == "updating"
    assert during[0]["results"][0]["id"] == "tactics"
    assert indexes.status()["indexes"]["vector"]["state"] == "error"
    assert indexes.status()["indexes"]["vector"]["available"] is True
    restarted = IndexCoordinator(WikiStore(tmp_path), {"vector": vectors})
    assert restarted._serving_receipt("vector") == original
    result = search_wiki(restarted.store, restarted, "zocken")
    assert result["mode"] == "semantic"
    assert result["results"][0]["id"] == "tactics"
    vectors.fail = False
    vectors.during_build = None
    restarted.run_once()
    assert restarted._serving_receipt("vector") != original
    assert "index_state" not in search_wiki(restarted.store, restarted, "zocken")


def test_stale_vectors_cannot_resurrect_deleted_or_changed_pages(tmp_path: Path) -> None:
    store, _, indexes = setup(tmp_path)
    old = store.get_page("tactics")
    assert old
    store.delete_page("tactics", old["revision"], "remove")
    assert search_wiki(store, indexes, "zocken")["results"] == []
    store.save_page("tactics", "# Unrelated\nA replacement.", None, "replace")
    assert search_wiki(store, indexes, "zocken")["results"] == []
    # The fresh wording is immediately searchable before any new embeddings.
    result = search_wiki(store, indexes, "replacement")
    assert result["results"][0]["id"] == "tactics"
    assert result["results"][0]["revision"] != old["revision"]
    assert result["results"][0]["score"] == 0


def test_config_change_does_not_query_an_incompatible_generation(tmp_path: Path) -> None:
    store, vectors, _ = setup(tmp_path)
    changed = IndexCoordinator(store, {"vector": vectors}, config_id="different-embedding-model")
    with pytest.raises(WikiError) as caught:
        changed.semantic_search("zocken")
    assert caught.value.code == "index_pending"
    fallback = search_wiki(store, changed, "strategy")
    assert fallback["mode"] == "lexical"
    assert fallback["index_state"] == "pending"
    assert fallback["results"][0]["id"] == "tactics"


def test_warm_search_never_loads_whole_wiki_or_builds_graph(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _, indexes = setup(tmp_path)
    search_wiki(store, indexes, "strategy")

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("Search must use prepared data, not full Markdown or graph")

    for method in ("snapshot", "list_pages", "_pages", "_graph", "_read_blobs", "_tree_blobs"):
        monkeypatch.setattr(store, method, forbidden)
    assert search_wiki(store, indexes, "zocken")["results"][0]["id"] == "tactics"
    assert search_wiki(store, indexes, "strategy", mode="lexical")["results"][0]["id"] == "tactics"
    # Also survives a fresh REST/MCP process without reading any Markdown again.
    restarted = WikiStore(tmp_path)
    for method in ("snapshot", "list_pages", "_pages", "_graph", "_read_blobs", "_tree_blobs"):
        monkeypatch.setattr(restarted, method, forbidden)
    assert restarted.search("strategy")[0]["id"] == "tactics"


def test_projection_only_decodes_changed_blobs_and_never_keeps_deleted_hits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = WikiStore(tmp_path)
    for number in range(12):
        store.save_page(f"page-{number}", f"# Page {number}\nOld wording.", None, f"seed-{number}")
    assert len(store.search("wording")) == 12
    other_process = WikiStore(tmp_path)
    page = other_process.get_page("page-3")
    assert page
    other_process.save_page("page-3", "# Revised\nBrandnew phrase.", page["revision"], "edit")
    original = store._read_blobs
    reads: list[list[str]] = []

    def track(entries: dict[str, bytes]) -> dict[str, bytes]:
        reads.append(list(entries))
        return original(entries)

    monkeypatch.setattr(store, "_read_blobs", track)
    assert store.search("brandnew")[0]["id"] == "page-3"
    assert reads == [["pages/page-3.md", "revisions/page-3"]]
    assert len(store.search("wording")) == 11
    assert len(reads) == 1
    other_process.delete_page("page-3", other_process.get_page("page-3")["revision"], "delete")  # type: ignore[index]
    assert store.search("brandnew") == []


def test_fts_input_is_data_and_unicode_queries_keep_existing_matching(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    store.save_page("straße", "# Straße\nGrüße aus Köln.", None, "unicode")
    assert store.search("STRASSE")[0]["id"] == "straße"
    assert store.search("KÖLN")[0]["id"] == "straße"
    assert store.search('" OR NEAR( ) * : -') == []
