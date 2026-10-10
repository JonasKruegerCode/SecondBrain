import json
from pathlib import Path
from typing import Any

from second_brain.wiki.mcp import create_mcp
from second_brain.wiki.store import WikiStore


def _data(result: Any) -> Any:
    if isinstance(result, dict):
        return result
    # FastMCP can return unstructured text, or text plus structured content.
    if isinstance(result, tuple):
        return result[1]
    return json.loads(result[0].text)


async def test_managed_mcp_shares_rest_store_and_guidance(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    mcp = create_mcp(store)
    tools = {tool.name for tool in await mcp.list_tools()}
    assert tools == {
        "get_page",
        "list_pages",
        "search_wiki",
        "get_graph",
        "save_page",
        "delete_page",
        "get_history",
    }
    resources = list(await mcp.read_resource("wiki://guidance"))
    assert "base_revision" in str(resources[0].content)
    result = _data(
        await mcp.call_tool(
            "save_page",
            {
                "id": "harbor",
                "markdown": "# Harbor\nFictional harbor.",
                "base_revision": None,
                "request_id": "mcp-create",
            },
        )
    )
    assert (store.get_page("harbor") or {})["revision"] == result["revision"]
    fetched = _data(await mcp.call_tool("get_page", {"id": "harbor"}))
    assert fetched["markdown"] == "# Harbor\nFictional harbor."
    assert _data(await mcp.call_tool("get_page", {"id": "missing"}))["error"] == "not_found"
