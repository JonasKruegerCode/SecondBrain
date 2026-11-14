"""Real embedded Qdrant, synthetic vectors; no model-quality claims."""

import logging
from copy import deepcopy
from pathlib import Path
from threading import Event
from typing import Any

import httpx
import pytest
from qdrant_client import QdrantClient
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.delivery_runtime import DeliveryWorker, _synchronized_delivery
from second_brain.wiki.index_adapters import QdrantSnapshotAdapter, page_chunks
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.mcp import create_mcp
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiStore

from .test_wiki_legacy_git import repository


class TailEmbedder:
    def __init__(self) -> None:
        self.inputs: list[str] = []

    def embed(self, text: str) -> list[float]:
        assert 0 < len(text) <= 2000
        self.inputs.append(text)
        return [1.0, 0.0] if "TAIL_EVIDENCE" in text else [0.0, 1.0]


@pytest.mark.parametrize("length", [0, 1, 1999, 2000, 2001, 3600, 3800, 140000])
def test_chunks_cover_exact_unicode_source_and_bounded_overlap(length: int) -> None:
    markdown = ("🌊漢e\u0301\r\n" * (length // 6 + 1))[:length]
    chunks = page_chunks(markdown)
    assert chunks[0][0] == 0
    assert chunks[-1][1] == len(markdown)
    assert all(markdown[start:end] == text and len(text) <= 2000 for start, end, text in chunks)
    rebuilt = chunks[0][2]
    for previous, chunk in zip(chunks, chunks[1:], strict=False):
        assert chunk[0] == previous[1] - 200
        assert chunk[1] > previous[1]
        rebuilt += markdown[previous[1] : chunk[1]]
    assert rebuilt == markdown


async def test_tail_retrieval_maps_to_one_current_article_and_preserves_source(
    tmp_path: Path,
) -> None:
    store = WikiStore(tmp_path)
    text = "# Synthetic archive\n" + "🌊" * 12000 + "\nTAIL_EVIDENCE"
    saved = store.save_page("archive", text, None, "seed")
    store.save_page("other", "# Other\nUnrelated synthetic content.", None, "other")
    before = deepcopy(store.snapshot())
    provider = TailEmbedder()
    client = QdrantClient(":memory:")
    indexes = IndexCoordinator(store, {"vector": QdrantSnapshotAdapter(client, provider, None)})
    try:
        assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
        result = indexes.semantic_search("TAIL_EVIDENCE")
        assert result["results"][0]["id"] == "archive"
        assert result["results"][0]["revision"] == saved["revision"]
        assert result["results"][0]["score"] == pytest.approx(1.0)
        assert len({hit["id"] for hit in result["results"]}) == len(result["results"]) == 2
        assert any("TAIL_EVIDENCE" in value for value in provider.inputs[:-1])
        assert store.snapshot() == before
        mcp = create_mcp(store, indexes=indexes)
        response = await mcp.call_tool("search_wiki", {"query": "TAIL_EVIDENCE"})
        assert isinstance(response, tuple)
        cutoff = indexes.semantic_search("TAIL_EVIDENCE", None)
        assert response[1] == cutoff
        assert [hit["id"] for hit in cutoff["results"]] == ["archive"]
        assert cutoff["results"][0]["score"] == pytest.approx(1.0)
        assert cutoff["cutoff"] is True
        limited = await mcp.call_tool(
            "search_wiki", {"query": "TAIL_EVIDENCE", "limit": 10}
        )
        assert isinstance(limited, tuple)
        assert limited[1] == result
        with TestClient(create_app(store.path, indexes=indexes)) as api:
            assert api.get("/api/wiki/search?q=TAIL_EVIDENCE&mode=semantic").json() == result
        receipt = indexes._receipt("vector")
        assert receipt is not None
        points, _ = client.scroll("managed_wiki_" + receipt["generation"], limit=100)
        archive = sorted(
            [
                point.payload
                for point in points
                if point.payload and point.payload["id"] == "archive"
            ],
            key=lambda payload: payload["chunk"],
        )
        assert archive[0]["start"] == 0 and archive[-1]["end"] == len(text)
        assert all(p["revision"] == saved["revision"] for p in archive)
        assert all(p["snapshot_revision"] == before["revision"] for p in archive)
        store.save_page("archive", "# Updated", saved["revision"], "edit")
        with TestClient(create_app(store.path, indexes=indexes)) as api:
            assert api.get("/api/wiki/search?q=TAIL_EVIDENCE&mode=semantic").status_code == 503
            assert api.get("/api/wiki/pages/archive").status_code == 200
    finally:
        indexes.close()


def test_many_chunks_do_not_crowd_out_other_article_results() -> None:
    client = QdrantClient(":memory:")

    class Provider:
        def embed(self, text: str) -> list[float]:
            return [1.0, 0.0] if "strong" in text else [0.8, 0.2]

    pages = [
        {"id": "long", "title": "Long", "revision": "long1", "markdown": "strong " * 12000},
        *[
            {"id": f"short-{i}", "title": "Short", "revision": "s1", "markdown": "other"}
            for i in range(3)
        ],
    ]
    try:
        adapter = QdrantSnapshotAdapter(client, Provider(), 2)
        adapter.build("crowding", {"revision": "head", "pages": pages})
        result = adapter.search("crowding", "strong", limit=3)
        assert result[0]["id"] == "long"
        assert len(result) == len({p["id"] for p in result}) == 3
    finally:
        client.close()


def test_empty_article_embeds_its_title_without_fabricating_source() -> None:
    client = QdrantClient(":memory:")
    provider = TailEmbedder()
    try:
        adapter = QdrantSnapshotAdapter(client, provider, 2)
        adapter.build(
            "empty_page",
            {
                "revision": "head",
                "pages": [
                    {"id": "empty", "title": "Empty article", "revision": "r1", "markdown": ""}
                ],
            },
        )
        assert provider.inputs == ["Empty article"]
        assert adapter.search("empty_page", "empty")[0]["id"] == "empty"
    finally:
        client.close()


def test_long_article_upload_uses_bounded_waited_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    client = QdrantClient(":memory:")
    original = client.upsert
    batches: list[int] = []

    def upsert(*args: Any, **kwargs: Any) -> Any:
        assert kwargs["wait"] is True
        batches.append(len(kwargs["points"]))
        return original(*args, **kwargs)

    monkeypatch.setattr(client, "upsert", upsert)
    try:
        QdrantSnapshotAdapter(client, TailEmbedder(), 2).build(
            "batched",
            {
                "revision": "head",
                "pages": [
                    {"id": "long", "title": "Long", "revision": "r1", "markdown": "x" * 140000}
                ],
            },
        )
        assert batches == [64, 14]
        assert client.count("managed_wiki_batched").count == 78
    finally:
        client.close()


@pytest.mark.parametrize("http_failure", [False, True])
def test_progress_logs_counts_and_safe_failure_type_not_private_source(
    caplog: pytest.LogCaptureFixture,
    http_failure: bool,
) -> None:
    class Provider:
        def embed(self, text: str) -> list[float]:
            if "FAIL" in text:
                if http_failure:
                    request = httpx.Request("POST", "https://synthetic.invalid/embeddings")
                    raise httpx.HTTPStatusError(
                        "private credential and source must not be logged",
                        request=request,
                        response=httpx.Response(402, request=request),
                    )
                raise TimeoutError("private credential and source must not be logged")
            return [1.0, 0.0]

    client = QdrantClient(":memory:")
    pages = [
        {"id": "private-id", "title": "Private title", "revision": "r1", "markdown": "safe"},
        {"id": "failure", "title": "Failure", "revision": "r2", "markdown": "FAIL"},
    ]
    try:
        with (
            caplog.at_level(logging.INFO, logger="second_brain.wiki.index_adapters"),
            pytest.raises((TimeoutError, httpx.HTTPStatusError)),
        ):
            QdrantSnapshotAdapter(client, Provider(), 2).build(
                "failure", {"pages": pages, "revision": "h"}
            )
        assert "page=1/2" in caplog.text and "page=2/2" in caplog.text
        assert "embedding_seconds=" in caplog.text and "elapsed_seconds=" in caplog.text
        assert (
            "error_type=HTTPStatusError" if http_failure else "error_type=TimeoutError"
        ) in caplog.text
        assert ("provider_status=402" if http_failure else "provider_status=None") in caplog.text
        assert all(
            value not in caplog.text
            for value in ["private-id", "Private title", "private credential", "FAIL"]
        )
        assert client.get_collections().collections == []
    finally:
        client.close()


def test_git_bootstrap_does_not_wait_for_provider_and_reading_survives_build(
    tmp_path: Path,
) -> None:
    """Git adoption is real; a held synthetic embedding proves startup isolation."""
    remote, _ = repository(tmp_path)
    store = WikiStore(tmp_path / "vault")
    entered, release = Event(), Event()

    class SlowProvider:
        def embed(self, text: str) -> list[float]:
            entered.set()
            if not release.wait(timeout=10):
                raise TimeoutError("Synthetic hold timed out")
            return [1.0, 0.0]

    indexes = IndexCoordinator(
        store,
        {
            "vector": QdrantSnapshotAdapter(
                QdrantClient(":memory:", force_disable_check_same_thread=True), SlowProvider(), 2
            )
        },
    )
    try:
        sync = ManagedGitSync(store, str(remote), "archive", "1_knowledge/wiki")
        delivery = _synchronized_delivery(store, indexes, sync)
        assert store.get_page("Home") is not None
        assert not entered.is_set()
        worker = DeliveryWorker(delivery, interval=0.05)
        worker.start()
        try:
            assert entered.wait(timeout=5)
            with TestClient(create_app(store.path, indexes=indexes)) as api:
                assert api.get("/api/wiki/health").status_code == 200
                assert (
                    api.get("/api/wiki/pages/Home").json()["markdown"] == "# Home\n\n[[Article]]\n"
                )
                assert api.get("/api/wiki/pages").status_code == 200
                assert (
                    api.get("/api/wiki/index-status").json()["indexes"]["vector"]["state"]
                    == "pending"
                )
        finally:
            release.set()
            worker.stop()
    finally:
        indexes.close()
