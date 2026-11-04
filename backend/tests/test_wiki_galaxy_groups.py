from pathlib import Path
from typing import Any

from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.galaxy_groups import galaxy_groups
from second_brain.wiki.mcp import create_mcp
from second_brain.wiki.store import WikiStore


def test_topology_is_deterministic_complete_and_not_semantic() -> None:
    nodes = [{"id": f"n{i}", "title": str(i)} for i in range(16)]
    nodes += [{"id": "alone", "title": "Alone"}, {"id": "self", "title": "Self"}]
    edges = [{"source": f"n{i}", "target": f"n{i + 1}"} for i in range(15)]
    edges += [{"source": "self", "target": "self"}, {"source": "absent", "target": "n0"}]
    groups = galaxy_groups(nodes, edges)
    assert groups == galaxy_groups(list(reversed(nodes)), list(reversed(edges)))
    members = [key for group in groups for key in group["members"]]
    assert len(members) == len(set(members)) == len(nodes)
    assert set(members) == {node["id"] for node in nodes}
    assert len({g["key"] for g in groups}) == len(groups)
    assert all(g["core"] in g["members"] for g in groups)
    assert {g["core"] for g in groups if g["source"] == "unlinked"} == {"alone", "self"}
    assert all(g["curated"] is False for g in groups)
    assert len([g for g in groups if g["source"] == "link_topology"]) == 3


def test_curated_anchor_and_unicode_order_match_the_browser() -> None:
    # JS UTF-16 sorts a supplementary character before a BMP private-use one.
    nodes: list[dict[str, Any]] = [
        {"id": key, "title": key, "galaxy": {"group": "records", "anchor": True}}
        for key in ["\ue000", "😀"]
    ]
    nodes[0]["galaxy"]["label"] = "Records"
    group = galaxy_groups(nodes, [])[0]
    assert group == {
        "id": 0,
        "key": "frontmatter:records",
        "group": "records",
        "core": "😀",
        "members": ["😀", "\ue000"],
        "label": "Records",
        "source": "frontmatter",
        "curated": True,
        "isolated": False,
    }


async def test_group_contract_shared_by_graph_rest_mcp_and_mutations(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    saved = store.save_page(
        "home",
        "---\ngalaxy_group: records\ngalaxy_label: Records\n"
        "galaxy_anchor: true\n---\n# Home\n[[note]]",
        None,
        "home",
    )
    store.save_page("note", "# Note\n[[home]]", None, "note")
    graph = store.graph()
    expected = {key: graph[key] for key in ("revision", "groups", "nodes")}
    with TestClient(create_app(tmp_path)) as client:
        response = client.get("/api/wiki/groups")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == expected
    mcp = create_mcp(store)
    tool_response = await mcp.call_tool("get_groups", {})
    assert isinstance(tool_response, tuple)
    assert tool_response[1] == expected
    text = str(list(await mcp.read_resource("wiki://guidance"))[0].content)
    assert all(
        word in text
        for word in [
            "galaxy_group",
            "galaxy_anchor",
            "galaxy_label",
            "link_topology",
            "base_revision",
            "multi-page",
        ]
    )
    graph["groups"][0]["members"].clear()
    assert store.graph()["groups"][0]["members"] == ["home"]
    store.save_page("home", "# Home\n[[note]]", saved["revision"], "remove-group")
    new = store.graph()
    assert new["revision"] != expected["revision"]
    assert all(g["source"] != "frontmatter" for g in new["groups"])
    assert store.snapshot()["graph"] == new
    restarted = WikiStore(tmp_path)
    assert restarted.graph() == new
