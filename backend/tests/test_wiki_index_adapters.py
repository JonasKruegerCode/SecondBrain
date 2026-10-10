from copy import deepcopy
from typing import Any
from unittest.mock import MagicMock

import pytest
from qdrant_client import QdrantClient

from second_brain.wiki.index_adapters import Neo4jSnapshotAdapter, QdrantSnapshotAdapter


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
    session.run.return_value = [{"id": "b"}]
    assert adapter.neighbors("namespace_attempt", ["a"], hops=3) == ["b"]
    call = session.run.call_args
    assert "*1..3" in call.args[0]
    assert "all(n IN nodes(path) WHERE n.generation = $generation)" in call.args[0]
    assert call.kwargs["generation"] == "namespace_attempt"
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
