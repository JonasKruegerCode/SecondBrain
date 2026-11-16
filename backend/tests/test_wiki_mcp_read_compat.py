"""Exercise legacy read arguments through actual SDK tool calls and snapshot receipts."""

from pathlib import Path
from typing import Any

import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.mcp import create_mcp
from second_brain.wiki.store import WikiStore


class Vector:
    def __init__(self) -> None:
        self.pages: list[dict[str, Any]] = []
        self.limits: list[int] = []

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        self.pages = snapshot["pages"]

    def search(self, generation: str, query: str, limit: int) -> list[dict[str, Any]]:
        self.limits.append(limit)
        return [
            {"id": p["id"], "revision": p["revision"], "score": 1.0} for p in self.pages[:limit]
        ]


class Graph:
    def __init__(self, store: WikiStore) -> None:
        self.store = store
        self.calls: list[tuple[list[str], int]] = []
        self.mutate = False

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        pass

    def neighbors(self, generation: str, seeds: list[str], hops: int, limit: int) -> list[str]:
        self.calls.append((seeds, hops))
        if self.mutate:
            self.store.save_page("changed", "# Changed", None, "concurrent-change")
        return {"alpha": ["beta"] if hops == 1 else ["beta", "gamma"], "beta": ["gamma"]}.get(
            seeds[0], []
        )[:limit]


def setup(path: Path) -> tuple[WikiStore, IndexCoordinator, Vector, Graph]:
    store = WikiStore(path)
    for name in ("alpha", "beta", "gamma"):
        store.save_page(name, f"# {name}\nShared content.", None, name)
    vector, graph = Vector(), Graph(store)
    indexes = IndexCoordinator(store, {"vector": vector, "graph": graph})
    indexes.run_once()
    return store, indexes, vector, graph


async def test_semantic_defaults_limits_and_per_hit_depth(tmp_path: Path) -> None:
    store, indexes, vector, graph = setup(tmp_path)
    async with create_connected_server_and_client_session(
        create_mcp(store, indexes=indexes)
    ) as sdk:
        result = await sdk.call_tool("search_wiki", {"query": "shared"})
        assert not result.isError
        assert vector.limits == [15]
        await sdk.call_tool("search_wiki", {"query": "shared", "mode": "semantic"})
        assert vector.limits[-1] == 10
        for depth in (1, 2):
            result = await sdk.call_tool(
                "search_wiki", {"query": "shared", "limit": 2, "hpos": depth}
            )
            assert not result.isError
            data = result.structuredContent
            assert data is not None
            hits = data["results"]
            assert [p["id"] for p in hits] == ["alpha", "beta"]
            assert [p["id"] for p in hits[0]["neighbors"]] == (
                ["beta"] if depth == 1 else ["beta", "gamma"]
            )
            assert [p["id"] for p in hits[1]["neighbors"]] == ["gamma"]
            assert graph.calls[-2:] == [(["alpha"], depth), (["beta"], depth)]
            assert vector.limits[-1] == 2


async def test_neighbors_single_id_alias_and_matching_inputs(tmp_path: Path) -> None:
    store, indexes, _, graph = setup(tmp_path)
    async with create_connected_server_and_client_session(
        create_mcp(store, indexes=indexes)
    ) as sdk:
        for args in ({"id": "alpha"}, {"ids": ["alpha"]}, {"id": "alpha", "ids": ["alpha"]}):
            result = await sdk.call_tool("get_neighbors", {**args, "hops": 2, "limit": 1})
            assert not result.isError
            assert result.structuredContent is not None
            assert [p["id"] for p in result.structuredContent["pages"]] == ["beta"]
        assert graph.calls == [(["alpha"], 2)] * 3


@pytest.mark.parametrize(
    "tool,args",
    [
        ("search_wiki", {"limit": 0}),
        ("search_wiki", {"limit": 51}),
        ("search_wiki", {"hpos": -1}),
        ("search_wiki", {"hpos": 3}),
        ("search_wiki", {"hpos": 1, "mode": "lexical"}),
        ("search_wiki", {"hpos": 1, "mode": "graph_rag"}),
        ("search_wiki", {"mode": "unknown"}),
        ("get_neighbors", {}),
        ("get_neighbors", {"id": "alpha", "ids": ["beta"]}),
    ],
)
async def test_incompatible_arguments_are_errors(
    tmp_path: Path, tool: str, args: dict[str, Any]
) -> None:
    store, indexes, _, _ = setup(tmp_path)
    async with create_connected_server_and_client_session(
        create_mcp(store, indexes=indexes)
    ) as sdk:
        result = await sdk.call_tool(
            tool, {"query": "shared", **args} if tool == "search_wiki" else args
        )
        assert result.isError
        assert result.structuredContent is not None
        assert result.structuredContent["error"] == "invalid_payload"


async def test_concurrent_change_never_returns_mixed_neighbors(tmp_path: Path) -> None:
    store, indexes, _, graph = setup(tmp_path)
    graph.mutate = True
    async with create_connected_server_and_client_session(
        create_mcp(store, indexes=indexes)
    ) as sdk:
        result = await sdk.call_tool("search_wiki", {"query": "shared", "hpos": 1})
        assert result.isError
        assert result.structuredContent is not None
        assert result.structuredContent["error"] == "index_pending"


async def test_unconfigured_lexical_truncation_and_explicit_limits(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    for number in range(51):
        store.save_page(f"page-{number:02d}", "# Shared\nShared text", None, str(number))
    async with create_connected_server_and_client_session(create_mcp(store)) as sdk:
        for args, count in (({}, 50), ({"mode": "lexical", "limit": 2}, 2)):
            result = await sdk.call_tool("search_wiki", {"query": "Shared", **args})
            assert not result.isError
            data = result.structuredContent
            assert data is not None
            assert data["mode"] == "lexical"
            assert len(data["results"]) == data["limit"] == count
            assert data["truncated"] is True


async def test_explicit_modes_and_graph_limit_are_honored(tmp_path: Path) -> None:
    store, indexes, vector, _ = setup(tmp_path)
    server = create_mcp(store, indexes=indexes)
    async with create_connected_server_and_client_session(server) as sdk:
        result = await sdk.call_tool(
            "search_wiki", {"query": "shared", "mode": "lexical", "limit": 1}
        )
        assert not result.isError
        assert result.structuredContent is not None
        assert result.structuredContent["mode"] == "lexical"
        assert len(result.structuredContent["results"]) == 1
        assert vector.limits == []
        result = await sdk.call_tool(
            "search_wiki", {"query": "shared", "mode": "graph_rag", "limit": 1}
        )
        assert not result.isError
        assert result.structuredContent is not None
        assert result.structuredContent["mode"] == "graph_rag"
        assert len(result.structuredContent["results"]) == 1
