"""Opt-in real database contracts; embeddings and all content are synthetic."""

import os
import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from neo4j import GraphDatabase
from neo4j.exceptions import ConstraintError
from qdrant_client import QdrantClient
from qdrant_client.http.exceptions import UnexpectedResponse
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.index_adapters import Neo4jSnapshotAdapter, QdrantSnapshotAdapter
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.mcp import create_mcp
from second_brain.wiki.scale_demo import create_scale_vault
from second_brain.wiki.store import WikiError, WikiStore

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("SECOND_BRAIN_RUN_INDEX_INTEGRATION") != "1",
        reason="Explicit disposable database acceptance is required",
    ),
]


class FixtureEmbedder:
    """Known vectors check server ranking, not model quality."""

    def embed(self, text: str) -> list[float]:
        return [1.0, 0.0] if "harbor" in text.lower() else [0.0, 1.0]


def adapters(neo4j_container: Any, qdrant_container: Any) -> dict[str, Any]:
    driver = GraphDatabase.driver(
        neo4j_container.get_connection_url(), auth=("neo4j", "password"), connection_timeout=3
    )
    client = QdrantClient(
        url=(
            f"http://{qdrant_container.get_container_host_ip()}:"
            f"{qdrant_container.get_exposed_port(6333)}"
        ),
        timeout=10,
    )
    try:
        driver.verify_connectivity()
        client.get_collections()
    except Exception:
        driver.close()
        client.close()
        raise
    return {
        "graph": Neo4jSnapshotAdapter(driver),
        "vector": QdrantSnapshotAdapter(client, FixtureEmbedder(), 2),
    }


@pytest.fixture
def indexed(
    tmp_path: Path, neo4j_container: Any, qdrant_container: Any, record_testsuite_property: Any
) -> Iterator[IndexCoordinator]:
    for name, container in (("neo4j", neo4j_container), ("qdrant", qdrant_container)):
        image = container.get_wrapped_container().image
        record_testsuite_property(name + "_image_id", image.id)
        record_testsuite_property(name + "_image_digests", ",".join(image.attrs["RepoDigests"]))
    store = WikiStore(tmp_path / "managed")
    store.save_page("home", "# Home\n[[harbor]]", None, "home-create")
    store.save_page("harbor", "# Harbor\n[[garden]]", None, "harbor-create")
    store.save_page("garden", "# Garden\nA quiet garden.", None, "garden-create")
    indexes = IndexCoordinator(store, adapters(neo4j_container, qdrant_container))
    try:
        yield indexes
    finally:
        indexes.close()


def current(indexes: IndexCoordinator) -> None:
    assert {v["state"] for v in indexes.run_once()["indexes"].values()} == {"current"}


def test_real_graph_generations_are_immutable_and_scoped(indexed: IndexCoordinator) -> None:
    current(indexed)
    graph = indexed.adapters["graph"]
    receipt = indexed._receipt("graph")
    assert receipt
    generation = receipt["generation"]
    assert graph.neighbors(generation, ["home"], hops=1) == ["harbor"]
    assert graph.neighbors(generation, ["home"], hops=2) == ["garden", "harbor"]
    assert graph.neighbors(generation, ["garden"], hops=2) == ["harbor", "home"]
    with pytest.raises(ConstraintError):
        graph.build(generation, indexed.store.snapshot())
    assert graph.neighbors(generation, ["home"], hops=2) == ["garden", "harbor"]
    foreign = "foreign_" + uuid4().hex
    graph.build(foreign, indexed.store.snapshot())
    assert graph.list_generations(indexed.namespace) == [generation]
    graph.delete_generation(generation)
    assert graph.neighbors(foreign, ["home"]) == ["harbor"]
    graph.delete_generation(foreign)


def test_real_vector_generations_ranking_reuse_and_empty(indexed: IndexCoordinator) -> None:
    current(indexed)
    vector = indexed.adapters["vector"]
    receipt = indexed._receipt("vector")
    assert receipt
    generation = receipt["generation"]
    hits = vector.search(generation, "harbor", limit=2)
    assert hits[0]["id"] in {"home", "harbor"}
    assert hits[0]["score"] == pytest.approx(1.0)
    with pytest.raises(UnexpectedResponse):
        vector.build(generation, indexed.store.snapshot())
    assert len(vector.search(generation, "harbor")) == 3
    empty = indexed.namespace + "_empty"
    vector.build(empty, {"revision": "empty", "pages": [], "graph": {"edges": []}})
    assert vector.search(empty, "harbor") == []
    vector.delete_generation(empty)
    assert vector.list_generations(indexed.namespace) == [generation]


async def test_real_indexes_shared_rest_mcp_and_stale_revision(indexed: IndexCoordinator) -> None:
    current(indexed)
    before = indexed.store.snapshot()
    mcp = create_mcp(indexed.store, indexes=indexed)
    response = await mcp.call_tool("search_wiki", {"query": "harbor", "mode": "semantic"})
    assert isinstance(response, tuple)
    _, structured = response
    assert structured == indexed.semantic_search("harbor")
    with TestClient(create_app(indexed.store.path, indexes=indexed)) as client:
        assert client.get("/api/wiki/search?q=harbor&mode=semantic").json() == structured
        assert client.get("/api/wiki/pages/home/neighbors?hops=2").json() == indexed.neighbors(
            ["home"], hops=2
        )
        assert client.get("/api/wiki/search?q=harbor&mode=graph_rag").status_code == 200
        assert indexed.store.snapshot() == before
        page = indexed.store.get_page("harbor")
        assert page
        indexed.store.delete_page("harbor", page["revision"], "remove-harbor")
        indexed.store.save_page("harbor", "# Harbor\nChanged incarnation.", None, "new-harbor")
        assert client.get("/api/wiki/search?q=harbor&mode=semantic").status_code == 503
        assert client.get("/api/wiki/search?q=harbor").status_code == 200
        current(indexed)
        fresh = indexed.semantic_search("harbor")
        hit = next(p for p in fresh["results"] if p["id"] == "harbor")
        assert hit["revision"] != page["revision"]
        assert {p["id"] for p in indexed.neighbors(["home"], hops=2)["pages"]} == {"harbor"}


def test_real_retention_preserves_current_and_untracked(indexed: IndexCoordinator) -> None:
    current(indexed)
    indexed.run_once(rebuild=True)
    generations = {}
    untracked = indexed.namespace + "_untracked"
    for kind, adapter in indexed.adapters.items():
        receipt = indexed._receipt(kind)
        assert receipt
        generations[kind] = receipt["generation"]
        adapter.build(untracked, indexed.store.snapshot())
    with sqlite3.connect(indexed.db_path) as db:
        db.execute("UPDATE generations SET created_at=0")
    planned = indexed.prune(keep_ready=1, min_age_seconds=0)
    for result in planned["indexes"].values():
        assert len(result["candidates"]) == 1
        assert result["deleted"] == []
        assert result["untracked"] == 1
    applied = indexed.prune(keep_ready=1, min_age_seconds=0, dry_run=False)
    for kind, adapter in indexed.adapters.items():
        assert applied["indexes"][kind]["deleted"] == planned["indexes"][kind]["candidates"]
        assert set(adapter.list_generations(indexed.namespace)) == {generations[kind], untracked}
    assert indexed.neighbors(["home"])["pages"][0]["id"] == "harbor"
    assert len(indexed.semantic_search("harbor")["results"]) == 3


def test_missing_real_graph_generation_is_explicit_and_rebuildable(
    indexed: IndexCoordinator,
) -> None:
    current(indexed)
    before = indexed.store.snapshot()
    receipt = indexed._receipt("graph")
    assert receipt
    indexed.adapters["graph"].delete_generation(receipt["generation"])
    with pytest.raises(WikiError) as error:
        indexed.neighbors(["home"])
    assert error.value.code == "index_unavailable"
    assert len(indexed.semantic_search("harbor")["results"]) == 3
    assert indexed.store.get_page("home")
    indexed.run_once(rebuild=True)
    assert indexed.neighbors(["home"])["pages"][0]["id"] == "harbor"
    assert indexed.store.snapshot() == before


def test_real_indexes_accept_large_snapshot_and_exact_graph_context(
    indexed: IndexCoordinator, tmp_path: Path, record_testsuite_property: Any
) -> None:
    vault = tmp_path / "scale"
    fixture = create_scale_vault(vault, count=320)
    assert fixture["pages"] == 320
    assert fixture["edges"] == 648
    record_testsuite_property("scale_pages", fixture["pages"])
    record_testsuite_property("scale_edges", fixture["edges"])
    scaled = IndexCoordinator(WikiStore(vault), indexed.adapters)
    before = scaled.store.snapshot()
    current(scaled)
    graph = before["graph"]
    seeds = {"scale-0000"}
    reachable = set(seeds)
    for _ in range(2):
        reachable |= {
            endpoint
            for edge in graph["edges"]
            if edge["source"] in reachable or edge["target"] in reachable
            for endpoint in (edge["source"], edge["target"])
        }
    actual = scaled.neighbors(list(seeds), hops=2)
    assert {page["id"] for page in actual["pages"]} == reachable - seeds
    assert actual["revision"] == before["revision"]
    results = scaled.semantic_search("observation", limit=50)
    assert len(results["results"]) == 50
    pages = {page["id"]: page for page in before["pages"]}
    assert all(hit["revision"] == pages[hit["id"]]["revision"] for hit in results["results"])
    assert scaled.graph_search("observation", hops=2)["revision"] == before["revision"]
    assert scaled.store.snapshot() == before


def test_real_server_restart_receipts_and_missing_vector_recovery(
    indexed: IndexCoordinator, neo4j_container: Any, qdrant_container: Any
) -> None:
    current(indexed)
    before = indexed.store.snapshot()
    receipts = {kind: indexed._receipt(kind) for kind in indexed.adapters}
    indexed.close()
    for container in (neo4j_container, qdrant_container):
        container.get_wrapped_container().restart(timeout=10)
    deadline = time.monotonic() + 90
    while True:
        try:
            restarted = IndexCoordinator(
                WikiStore(indexed.store.path), adapters(neo4j_container, qdrant_container)
            )
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.5)
    try:
        assert restarted.namespace == indexed.namespace
        current(restarted)
        assert {kind: restarted._receipt(kind) for kind in restarted.adapters} == receipts
        assert {p["id"] for p in restarted.neighbors(["home"], hops=2)["pages"]} == {
            "garden", "harbor"
        }
        assert len(restarted.semantic_search("harbor")["results"]) == 3
        receipt = restarted._receipt("vector")
        assert receipt
        restarted.adapters["vector"].delete_generation(receipt["generation"])
        with pytest.raises(WikiError) as error:
            restarted.semantic_search("harbor")
        assert error.value.code == "index_unavailable"
        assert restarted.neighbors(["home"])["pages"][0]["id"] == "harbor"
        assert restarted.store.get_page("home")
        restarted.run_once(rebuild=True)
        assert len(restarted.semantic_search("harbor")["results"]) == 3
        assert restarted.store.snapshot() == before
    finally:
        restarted.close()
