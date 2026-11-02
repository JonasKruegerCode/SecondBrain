"""Real embedded Qdrant tests for provider-derived managed vector dimensions."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from qdrant_client import QdrantClient, models

from second_brain.wiki.index_adapters import QdrantSnapshotAdapter


class SyntheticEmbedder:
    def __init__(self, vectors: dict[str, list[float]]) -> None:
        self.vectors = vectors
        self.calls: list[str] = []

    def embed(self, text: str) -> list[float]:
        self.calls.append(text)
        return self.vectors[text]


def snapshot(*texts: str) -> dict[str, Any]:
    return {
        "revision": "synthetic-snapshot",
        "pages": [
            {"id": f"page-{i}", "revision": f"revision-{i}", "markdown": text}
            for i, text in enumerate(texts)
        ],
    }


@pytest.mark.parametrize("dimension", [2, 7, 19])
def test_infers_actual_page_dimension_and_searches(dimension: int) -> None:
    client = QdrantClient(":memory:")
    embedder = SyntheticEmbedder({"page": [1.0] * dimension, "query": [1.0] * dimension})
    adapter = QdrantSnapshotAdapter(client, embedder, None)
    try:
        adapter.build("synthetic", snapshot("page"))
        assert embedder.calls == ["page"]
        vectors = client.get_collection("managed_wiki_synthetic").config.params.vectors
        assert isinstance(vectors, models.VectorParams)
        assert vectors.size == dimension
        assert adapter.search("synthetic", "query")[0]["id"] == "page-0"
        assert embedder.calls == ["page", "query"]
    finally:
        client.close()


def test_empty_snapshot_probes_actual_embedder_and_search_reuses_dimension() -> None:
    class ProbeEmbedder:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def embed(self, text: str) -> list[float]:
            self.calls.append(text)
            return [1.0] * 11

    client = QdrantClient(":memory:")
    embedder = ProbeEmbedder()
    try:
        adapter = QdrantSnapshotAdapter(client, embedder, None)
        adapter.build("empty", snapshot())
        assert len(embedder.calls) == 1
        vectors = client.get_collection("managed_wiki_empty").config.params.vectors
        assert isinstance(vectors, models.VectorParams)
        assert vectors.size == 11
        assert adapter.search("empty", "query") == []
        assert len(embedder.calls) == 2
        assert embedder.calls[-1] == "query"
    finally:
        client.close()


def test_restart_uses_persisted_collection_dimension_and_detects_provider_drift(
    tmp_path: Path,
) -> None:
    path = str(tmp_path / "qdrant")
    first = QdrantClient(path=path)
    QdrantSnapshotAdapter(first, SyntheticEmbedder({"page": [1.0, 0.0, 0.0]}), None).build(
        "persisted", snapshot("page")
    )
    first.close()
    restarted = QdrantClient(path=path)
    embedder = SyntheticEmbedder({"query": [1.0, 0.0, 0.0], "drift": [1.0, 0.0]})
    try:
        adapter = QdrantSnapshotAdapter(restarted, embedder, None)
        assert adapter.search("persisted", "query")[0]["id"] == "page-0"
        with pytest.raises(ValueError, match="dimension"):
            adapter.search("persisted", "drift")
        assert embedder.calls == ["query", "drift"]
        assert restarted.get_collection("managed_wiki_persisted").points_count == 1
    finally:
        restarted.close()


@pytest.mark.parametrize("bad", [[], [float("nan")], [float("inf")], [1.0, 2.0]])
def test_invalid_page_vectors_fail_before_collection_creation(bad: list[float]) -> None:
    client = QdrantClient(":memory:")
    try:
        adapter = QdrantSnapshotAdapter(
            client, SyntheticEmbedder({"first": [1.0], "bad": bad}), None
        )
        with pytest.raises(ValueError, match="dimension|nonfinite"):
            adapter.build("invalid", snapshot("first", "bad"))
        assert client.get_collections().collections == []
    finally:
        client.close()


@pytest.mark.parametrize("bad", [[], [float("nan")], [float("-inf")]])
def test_invalid_empty_snapshot_probe_does_not_create_collection(bad: list[float]) -> None:
    class InvalidProbe:
        def embed(self, text: str) -> list[float]:
            return bad

    client = QdrantClient(":memory:")
    try:
        with pytest.raises(ValueError, match="dimension|nonfinite"):
            QdrantSnapshotAdapter(client, InvalidProbe(), None).build("invalid", snapshot())
        assert client.get_collections().collections == []
    finally:
        client.close()


def test_explicit_dimension_still_enforces_contract_without_empty_probe() -> None:
    client = QdrantClient(":memory:")
    embedder = SyntheticEmbedder({"bad": [1.0]})
    try:
        adapter = QdrantSnapshotAdapter(client, embedder, 4)
        adapter.build("empty", snapshot())
        assert embedder.calls == []
        with pytest.raises(ValueError, match="dimension"):
            adapter.build("bad", snapshot("bad"))
        assert not client.collection_exists("managed_wiki_bad")
    finally:
        client.close()
