from copy import deepcopy
from typing import Any
from unittest.mock import MagicMock

import pytest
from qdrant_client import QdrantClient

from second_brain.wiki.index_adapters import (
    Neo4jSnapshotAdapter,
    QdrantSnapshotAdapter,
    page_chunks,
)


class SyntheticEmbedder:
    def embed(self, text: str) -> list[float]:
        return [1.0, 0.0] if "alpha" in text else [0.0, 1.0]


def snapshot() -> dict[str, Any]:
    return {
        "revision": "head1",
        "pages": [
            {"id": "a", "title": "A", "revision": "a1", "markdown": "alpha"},
            {"id": "b", "title": "B", "revision": "b1", "markdown": "beta"},
        ],
        "graph": {
            "nodes": [{"id": "a"}, {"id": "b"}],
            "edges": [{"source": "a", "target": "b", "rel": "cites"}],
        },
    }


def test_real_embedded_qdrant_generations() -> None:
    client = QdrantClient(":memory:")
    adapter = QdrantSnapshotAdapter(client, SyntheticEmbedder(), 2)
    adapter.build("namespace_attempt1", snapshot())
    assert adapter.search("namespace_attempt1", "alpha")[0] == {
        "id": "a",
        "revision": "a1",
        "score": 1.0,
    }
    changed = snapshot()
    changed["pages"] = [{"id": "b", "title": "B", "revision": "b2", "markdown": "alpha"}]
    changed["revision"] = "head2"
    changed["graph"] = {"nodes": [{"id": "b"}], "edges": []}
    adapter.build("namespace_attempt2", changed)
    assert adapter.search("namespace_attempt2", "alpha") == [
        {"id": "b", "revision": "b2", "score": 1.0},
    ]
    assert len(adapter.search("namespace_attempt1", "alpha")) == 2
    with pytest.raises(ValueError):
        adapter.build("namespace_attempt1", snapshot())
    empty = {"revision": "empty", "pages": [], "graph": {"nodes": [], "edges": []}}
    adapter.build("namespace_empty", empty)
    assert adapter.search("namespace_empty", "alpha") == []
    assert {c.name for c in client.get_collections().collections} == {
        "managed_wiki_namespace_attempt1",
        "managed_wiki_namespace_attempt2",
        "managed_wiki_namespace_empty",
    }
    assert adapter.list_generations("namespace") == [
        "namespace_attempt1",
        "namespace_attempt2",
        "namespace_empty",
    ]
    adapter.delete_generation("namespace_attempt1")
    assert {c.name for c in client.get_collections().collections} == {
        "managed_wiki_namespace_attempt2",
        "managed_wiki_namespace_empty",
    }
    client.close()


def test_qdrant_group_ties_have_stable_article_order(monkeypatch: pytest.MonkeyPatch) -> None:
    client = QdrantClient(":memory:")
    try:
        adapter = QdrantSnapshotAdapter(client, SyntheticEmbedder(), 2)
        data = snapshot()
        data["pages"].append(
            {"id": "c", "title": "C", "revision": "c1", "markdown": "alpha"}
        )
        adapter.build("ties_attempt", data)
        query = client.query_points_groups
        reverse = False

        def alternating_groups(**kwargs: Any) -> Any:
            nonlocal reverse
            result = query(**kwargs)
            reverse = not reverse
            if reverse:
                result.groups.reverse()
            return result

        monkeypatch.setattr(client, "query_points_groups", alternating_groups)
        expected = [
            {"id": "a", "revision": "a1", "score": 1.0},
            {"id": "c", "revision": "c1", "score": 1.0},
            {"id": "b", "revision": "b1", "score": 0.0},
        ]
        assert adapter.search("ties_attempt", "alpha") == expected
        assert adapter.search("ties_attempt", "alpha") == expected
    finally:
        client.close()


@pytest.mark.parametrize("length", [1_999, 2_000, 2_001, 140_000])
def test_long_pages_cover_all_chunks_without_changing_markdown(length: int) -> None:
    class BoundedProvider:
        def __init__(self) -> None:
            self.inputs: list[str] = []

        def embed(self, text: str) -> list[float]:
            if len(text) > 2_000:
                raise ValueError("Provider input limit exceeded")
            self.inputs.append(text)
            return [1.0, 0.0]

    markdown = "# Synthetic long article\n\n" + "🌊" * (length - 26)
    assert len(markdown) == length
    data = snapshot()
    data["pages"] = [{"id": "a", "title": "A", "revision": "a1", "markdown": markdown}]
    data["graph"] = {"nodes": [{"id": "a"}], "edges": []}
    original = deepcopy(data)
    provider = BoundedProvider()
    client = QdrantClient(":memory:")
    try:
        adapter = QdrantSnapshotAdapter(client, provider, None)
        adapter.build("bounded_attempt", data)
        assert provider.inputs == [text for _, _, text in page_chunks(markdown)]
        assert provider.inputs[-1].endswith(markdown[-100:])
        assert adapter.search("bounded_attempt", "synthetic")[0]["id"] == "a"
        assert data == original
    finally:
        client.close()


@pytest.mark.parametrize("vector", [[1.0], [float("nan"), 0.0], [float("inf"), 0.0]])
def test_invalid_vectors_do_not_create_collection(vector: list[float]) -> None:
    client = QdrantClient(":memory:")
    embedder = MagicMock()
    embedder.embed.return_value = vector
    adapter = QdrantSnapshotAdapter(client, embedder, 2)
    with pytest.raises(ValueError, match="Embedding"):
        adapter.build("invalid", snapshot())
    assert client.get_collections().collections == []
    client.close()


def test_neo4j_single_transaction_and_scoped_neighbors() -> None:
    driver = MagicMock()
    session = driver.session.return_value.__enter__.return_value
    tx = MagicMock()
    session.execute_write.side_effect = lambda function, *args: function(tx, *args)
    adapter = Neo4jSnapshotAdapter(driver)
    adapter.build("namespace_attempt", snapshot())
    session.execute_write.assert_called_once()
    assert tx.run.call_count == 3
    queries = [call.args[0] for call in tx.run.call_args_list]
    assert all("ManagedWiki" in query for query in queries)
    assert "CREATE (:ManagedWikiGeneration" in queries[0]
    assert "CREATE (a)-[:LINKS_TO" in queries[2]
    assert tx.run.call_args_list[2].kwargs["edges"][0]["rel"] == "cites"
    session.execute_read.side_effect = lambda function: function(tx)
    tx.run.return_value = MagicMock()
    tx.run.return_value.__iter__.return_value = iter([{"id": "b"}])
    assert adapter.neighbors("namespace_attempt", ["a"], hops=3) == ["b"]
    call = tx.run.call_args
    assert "*1..3" in call.args[0]
    assert "all(n IN nodes(path) WHERE n.generation = $generation)" in call.args[0]
    assert call.kwargs["generation"] == "namespace_attempt"
    session.run.return_value = [{"generation": "namespace_attempt"}]
    assert adapter.list_generations("namespace") == ["namespace_attempt"]
    assert session.run.call_args.kwargs["prefix"] == "namespace_"
    adapter.delete_generation("namespace_attempt")
    assert session.execute_write.call_count == 2
    delete_tx = MagicMock()
    Neo4jSnapshotAdapter._delete(delete_tx, "namespace_attempt")
    assert delete_tx.run.call_count == 2
    assert all(
        call.kwargs["generation"] == "namespace_attempt"
        for call in delete_tx.run.call_args_list
    )
    with pytest.raises(ValueError):
        adapter.neighbors("namespace_attempt", ["a"], hops=4)


def test_bad_generation_and_graph_rejected_before_writes() -> None:
    driver = MagicMock()
    adapter = Neo4jSnapshotAdapter(driver)
    with pytest.raises(ValueError):
        adapter.build("unsafe-name", snapshot())
    broken = deepcopy(snapshot())
    broken["graph"]["edges"][0]["target"] = "missing"
    with pytest.raises(ValueError, match="missing"):
        adapter.build("valid", broken)
    driver.session.assert_not_called()


def test_missing_graph_generation_is_not_a_valid_empty_neighborhood() -> None:
    driver = MagicMock()
    session = driver.session.return_value.__enter__.return_value
    tx = MagicMock()
    session.execute_read.side_effect = lambda function: function(tx)
    tx.run.return_value.single.return_value = None
    session.run.return_value = []
    adapter = Neo4jSnapshotAdapter(driver)
    with pytest.raises(RuntimeError, match="generation is unavailable"):
        adapter.neighbors("lost_generation", ["home"])
    assert tx.run.call_count == 1
    tx.run.return_value.single.return_value = {"generation": "empty_generation"}
    tx.run.return_value.__iter__.return_value = iter([])
    assert adapter.neighbors("empty_generation", ["home"]) == []


def test_qdrant_writes_wait_and_does_not_publish_failed_attempt() -> None:
    client = MagicMock(spec=QdrantClient)
    adapter = QdrantSnapshotAdapter(client, SyntheticEmbedder(), 2)
    client.upsert.side_effect = RuntimeError("offline")
    with pytest.raises(RuntimeError, match="offline"):
        adapter.build("failed_attempt", snapshot())
    assert client.upsert.call_args.kwargs["wait"] is True
    assert client.upsert.call_args.kwargs["collection_name"] == "managed_wiki_failed_attempt"
    client.upsert.side_effect = None
    adapter.build("fresh_attempt", snapshot())
    assert client.create_collection.call_args.kwargs["collection_name"] == (
        "managed_wiki_fresh_attempt"
    )
