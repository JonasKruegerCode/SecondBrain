import gc
from pathlib import Path
from typing import Any

import pytest
from qdrant_client import QdrantClient
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.index_adapters import QdrantSnapshotAdapter
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.mcp import create_mcp
from second_brain.wiki.store import WikiError, WikiStore


class SyntheticEmbedder:
    def embed(self, text: str) -> list[float]:
        return [1.0, float("harbor" in text.lower())]


class Graph:
    def __init__(self) -> None:
        self.generations: dict[str, dict[str, Any]] = {}
        self.fail = False
        self.callback: Any = None

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        if self.callback:
            self.callback()
        if self.fail:
            raise RuntimeError("private provider detail must never be returned")
        self.generations[generation] = snapshot

    def neighbors(self, generation: str, seeds: list[str], hops: int, limit: int) -> list[str]:
        return [
            e["target"]
            for e in self.generations[generation]["graph"]["edges"]
            if e["source"] in seeds
        ][:limit]


def setup(tmp_path: Path) -> tuple[WikiStore, Graph, IndexCoordinator]:
    store = WikiStore(tmp_path)
    store.save_page("home", "# Home\n[[harbor]]", None, "home-create")
    store.save_page("harbor", "# Harbor\nA quiet harbor.", None, "harbor-create")
    graph = Graph()
    vector = QdrantSnapshotAdapter(QdrantClient(":memory:"), SyntheticEmbedder(), 2)
    return store, graph, IndexCoordinator(store, {"graph": graph, "vector": vector})


def test_restart_separate_receipts_and_no_content_mutation(tmp_path: Path) -> None:
    store, graph, indexes = setup(tmp_path)
    before = store.snapshot()
    graph.fail = True
    result = indexes.run_once()
    assert result["indexes"]["graph"]["state"] == "error"
    assert result["indexes"]["vector"]["state"] == "current"
    assert "private provider" not in str(result)
    assert {p["id"] for p in indexes.semantic_search("harbor")["results"]} == {"home", "harbor"}
    graph.fail = False
    restarted = IndexCoordinator(WikiStore(tmp_path), indexes.adapters)
    assert restarted.namespace == indexes.namespace
    restarted.run_once()
    assert restarted.neighbors(["home"])["pages"][0]["id"] == "harbor"
    assert store.snapshot() == before
    receipt = restarted._receipt("vector")
    restarted.run_once()
    assert restarted._receipt("vector") == receipt  # no repeated provider spend


def test_late_snapshot_never_current_then_reconstructs_pending(tmp_path: Path) -> None:
    store, graph, indexes = setup(tmp_path)
    graph.callback = lambda: store.save_page("new", "# New", None, "during-build")
    assert indexes.run_once()["indexes"]["vector"]["state"] == "pending"
    with pytest.raises(WikiError, match="not completed"):
        indexes.semantic_search("harbor")
    graph.callback = None
    restarted = IndexCoordinator(store, indexes.adapters)
    assert restarted.run_once()["indexes"]["vector"]["state"] == "current"
    assert {p["id"] for p in restarted.semantic_search("harbor")["results"]} == {
        "home",
        "harbor",
        "new",
    }


def test_delete_recreate_and_empty_snapshot_drop_old_points(tmp_path: Path) -> None:
    store, _, indexes = setup(tmp_path)
    indexes.run_once()
    old = store.get_page("harbor")
    assert old
    store.delete_page("harbor", old["revision"], "delete")
    store.save_page("harbor", "# Harbor\nChanged content", None, "recreate")
    indexes.run_once()
    hit = next(p for p in indexes.semantic_search("harbor")["results"] if p["id"] == "harbor")
    assert hit["revision"] != old["revision"]
    for page in store.list_pages():
        store.delete_page(page["id"], page["revision"], "remove-" + page["id"])
    indexes.run_once()
    assert indexes.semantic_search("harbor")["results"] == []


def test_failed_receipt_replays_into_fresh_generation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, graph, indexes = setup(tmp_path)
    original = indexes._db
    calls = 0

    def crash() -> Any:
        nonlocal calls
        calls += 1
        if calls == 2:  # receipt write after provider completed
            raise RuntimeError("simulated process loss")
        return original()

    monkeypatch.setattr(indexes, "_db", crash)
    with pytest.raises(RuntimeError, match="process loss"):
        indexes.run_once()
    monkeypatch.setattr(indexes, "_db", original)
    assert indexes._receipt("graph") is None
    first_generation = next(iter(graph.generations))
    restarted = IndexCoordinator(store, indexes.adapters)
    restarted.run_once()
    assert restarted._receipt("graph")["generation"] != first_generation  # type: ignore[index]
    assert len(graph.generations) == 2


def test_worker_lock_and_configuration_change(tmp_path: Path) -> None:
    store, graph, indexes = setup(tmp_path)
    competitor = IndexCoordinator(store, indexes.adapters)
    nested: list[dict[str, Any]] = []
    graph.callback = lambda: nested.append(competitor.run_once())
    indexes.run_once()
    assert nested[0]["worker"] == "busy"
    assert (
        IndexCoordinator(store, indexes.adapters, config_id="new-model").status()["indexes"][
            "vector"
        ]["state"]
        == "pending"
    )


def test_rest_shared_semantic_status_and_bounds(tmp_path: Path) -> None:
    store, _, indexes = setup(tmp_path)
    with TestClient(create_app(tmp_path, indexes=indexes)) as client:
        assert client.get("/api/wiki/search?q=harbor&mode=semantic").status_code == 503
        assert client.get("/api/wiki/search?q=harbor").status_code == 200
        indexes.run_once()
        assert client.get("/api/wiki/index-status").json() == indexes.status()
        assert client.get(
            "/api/wiki/search?q=harbor&mode=semantic"
        ).json() == indexes.semantic_search("harbor")
        assert client.get("/api/wiki/pages/home/neighbors?hops=4").status_code == 400
        assert client.get("/api/wiki/pages/home/neighbors?hops=oops").status_code == 400
        assert client.get("/api/wiki/pages/home/neighbors").json()["pages"][0]["id"] == "harbor"
        assert client.get("/api/wiki/index-status").headers["cache-control"] == "no-store"
    assert store._head() == indexes.status()["revision"]


async def test_mcp_semantic_and_expansion_share_coordinator(tmp_path: Path) -> None:
    store, _, indexes = setup(tmp_path)
    indexes.run_once()
    mcp = create_mcp(store, indexes=indexes)
    response = await mcp.call_tool("search_wiki", {"query": "harbor", "mode": "semantic"})
    assert isinstance(response, tuple)
    _, structured = response
    assert structured == indexes.semantic_search("harbor")
    response = await mcp.call_tool("get_neighbors", {"ids": ["home"]})
    assert isinstance(response, tuple)
    _, structured = response
    assert structured == indexes.neighbors(["home"])


def test_sqlite_connections_close_without_gc(tmp_path: Path) -> None:
    indexes = IndexCoordinator(WikiStore(tmp_path))
    descriptors = Path("/proc/self/fd")
    if not descriptors.exists():
        pytest.skip("Linux descriptor accounting")
    before = len(list(descriptors.iterdir()))
    gc.disable()
    try:
        for _ in range(30):
            indexes.status()
        assert len(list(descriptors.iterdir())) <= before + 1
    finally:
        gc.enable()


def test_provider_query_failure_and_mid_query_write_are_explicit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _, indexes = setup(tmp_path)
    indexes.run_once()
    vector = indexes.adapters["vector"]
    search = vector.search

    def failing(*args: Any) -> Any:
        raise RuntimeError("private access token")

    monkeypatch.setattr(vector, "search", failing)
    with pytest.raises(WikiError) as error:
        indexes.semantic_search("harbor")
    assert error.value.code == "index_unavailable"
    assert "token" not in error.value.message

    def racing(*args: Any) -> Any:
        result = search(*args)
        store.save_page("later", "# Later", None, "mid-query")
        return result

    monkeypatch.setattr(vector, "search", racing)
    with pytest.raises(WikiError) as error:
        indexes.semantic_search("harbor")
    assert error.value.code == "index_pending"


def test_vector_seeds_graph_context_and_stale_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, _, indexes = setup(tmp_path)
    indexes.run_once()
    home = store.get_page("home")
    assert home
    monkeypatch.setattr(
        indexes.adapters["vector"],
        "search",
        lambda *args: [
            {"id": "home", "revision": home["revision"], "score": 1.0},
            {"id": "harbor", "revision": "stale", "score": 0.9},
            {"id": "ghost", "revision": "fake", "score": 0.8},
        ],
    )
    result = indexes.graph_search("harbor")
    assert [(p["id"], p["retrieval"]) for p in result["results"]] == [
        ("home", "vector"),
        ("harbor", "graph"),
    ]
    assert "score" not in result["results"][1]
