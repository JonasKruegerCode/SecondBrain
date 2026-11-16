"""Reuse actual Qdrant vectors while preserving immutable generation receipts."""

from pathlib import Path
from typing import Any

import pytest
from qdrant_client import QdrantClient

from second_brain.wiki.index_adapters import QdrantSnapshotAdapter, page_chunks
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


class Provider:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.fail = False

    def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        if self.fail:
            raise RuntimeError("Synthetic provider error")
        return [1.0, 0.0] if "tail" in text else [0.0, 1.0]


def setup(tmp_path: Path) -> tuple[WikiStore, QdrantClient, Provider, IndexCoordinator]:
    store = WikiStore(tmp_path / "vault")
    store.save_page("long", "# Archive\n" + "x" * 5000 + " tail", None, "seed-long")
    store.save_page("short", "# Short", None, "seed-short")
    client = QdrantClient(path=str(tmp_path / "engine"))
    provider = Provider()
    indexes = IndexCoordinator(store, {"vector": QdrantSnapshotAdapter(client, provider, 2)})
    assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
    assert len(provider.calls) == 4
    provider.calls.clear()
    return store, client, provider, indexes


def test_append_reuses_unchanged_chunks_and_publishes_fresh_provenance(tmp_path: Path) -> None:
    store, client, provider, indexes = setup(tmp_path)
    try:
        receipt = indexes._receipt("vector")
        assert receipt is not None
        old_points, _ = client.scroll("managed_wiki_" + receipt["generation"], limit=100)
        original = store.get_page("long")
        assert original is not None
        updated = store.save_page(
            "long", original["markdown"] + " appended", original["revision"], "append"
        )
        assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
        assert provider.calls == [page_chunks(updated["markdown"])[-1][2]]
        current = indexes._receipt("vector")
        assert current is not None and current["generation"] != receipt["generation"]
        points, _ = client.scroll("managed_wiki_" + current["generation"], limit=100)
        assert all(p.payload and p.payload["snapshot_revision"] == store._head() for p in points)
        assert all(
            p.payload["revision"] == updated["revision"]
            for p in points
            if p.payload and p.payload["id"] == "long"
        )
        assert client.scroll("managed_wiki_" + receipt["generation"], limit=100)[0] == old_points
        assert indexes.semantic_search("tail")["results"][0]["revision"] == updated["revision"]
    finally:
        indexes.close()


def test_restart_and_revision_only_edit_need_no_model_calls(tmp_path: Path) -> None:
    store, client, provider, indexes = setup(tmp_path)
    indexes.close()
    client = QdrantClient(path=str(tmp_path / "engine"))
    provider = Provider()
    restarted = IndexCoordinator(store, {"vector": QdrantSnapshotAdapter(client, provider, 2)})
    try:
        page = store.get_page("long")
        assert page is not None
        store.save_page("long", page["markdown"], page["revision"], "same-text")
        assert restarted.run_once()["indexes"]["vector"]["state"] == "current"
        assert provider.calls == []
        assert len(restarted.semantic_search("tail")["results"]) == 2
    finally:
        restarted.close()


def test_error_retry_retains_ready_source_and_prune_protects_it(tmp_path: Path) -> None:
    store, client, provider, indexes = setup(tmp_path)
    try:
        source = indexes._reuse_source("vector")
        page = store.get_page("short")
        assert page is not None
        store.save_page("short", "# Changed", page["revision"], "edit")
        provider.fail = True
        assert indexes.run_once()["indexes"]["vector"]["state"] == "error"
        assert indexes._reuse_source("vector") == source
        planned = indexes.prune(keep_ready=1, min_age_seconds=0)
        assert source not in planned["indexes"]["vector"]["candidates"]
        provider.fail = False
        provider.calls.clear()
        # Recreate coordinator as after a crash, keeping the durable source.
        restarted = IndexCoordinator(store, {"vector": indexes.adapters["vector"]})
        assert restarted.run_once()["indexes"]["vector"]["state"] == "current"
        assert provider.calls == ["# Changed"]
    finally:
        indexes.close()


@pytest.mark.parametrize("kind", ["rebuild", "config", "missing"])
def test_forced_rebuild_changed_config_or_missing_source_embeds_every_chunk(
    tmp_path: Path,
    kind: str,
) -> None:
    store, client, provider, indexes = setup(tmp_path)
    try:
        if kind == "config":
            indexes = IndexCoordinator(store, indexes.adapters, config_id="different-model")
        elif kind == "missing":
            source = indexes._reuse_source("vector")
            assert source is not None
            client.delete_collection("managed_wiki_" + source)
        if kind != "rebuild":
            page = store.get_page("short")
            assert page is not None
            store.save_page("short", page["markdown"], page["revision"], "new-revision")
        indexes.run_once(rebuild=kind == "rebuild")
        assert indexes.status()["indexes"]["vector"]["state"] == "current"
        assert len(provider.calls) == 4
    finally:
        indexes.close()


def test_invalid_reuse_payload_is_reembedded_and_deleted_pages_do_not_leak(tmp_path: Path) -> None:
    store, client, provider, indexes = setup(tmp_path)
    try:
        source = indexes._reuse_source("vector")
        assert source is not None
        records, _ = client.scroll("managed_wiki_" + source, limit=100)
        point = next(p for p in records if p.payload and p.payload["id"] == "short")
        client.set_payload("managed_wiki_" + source, {"chunk_hash": "invalid"}, points=[point.id])
        long = store.get_page("long")
        assert long is not None
        store.delete_page("long", long["revision"], "delete")
        indexes.run_once()
        assert provider.calls == ["# Short"]
        assert [hit["id"] for hit in indexes.semantic_search("tail")["results"]] == ["short"]
    finally:
        indexes.close()


def test_current_poll_does_not_load_full_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, client, provider, indexes = setup(tmp_path)
    try:

        def fail() -> dict[str, Any]:
            raise AssertionError("A current idle poll must not parse the vault")

        monkeypatch.setattr(store, "snapshot", fail)
        assert indexes.run_once()["worker"] == "idle"
        assert provider.calls == []
    finally:
        indexes.close()


def test_reuse_read_failure_preserves_source_without_spending_model_calls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, client, provider, indexes = setup(tmp_path)
    retrieve = client.retrieve
    try:
        source = indexes._reuse_source("vector")
        page = store.get_page("short")
        assert page is not None
        store.save_page("short", page["markdown"], page["revision"], "revision-only")

        def offline(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("Synthetic Qdrant transport failure")

        monkeypatch.setattr(client, "retrieve", offline)
        assert indexes.run_once()["indexes"]["vector"]["state"] == "error"
        assert provider.calls == [] and indexes._reuse_source("vector") == source
        monkeypatch.setattr(client, "retrieve", retrieve)
        assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
        assert provider.calls == []
    finally:
        indexes.close()
