"""Real SDK client and managed stdio subprocesses sharing one synthetic vault."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import anyio
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import CallToolResult, TextContent, TextResourceContents
from pydantic import AnyUrl
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.store import WikiStore


def _error(result: CallToolResult) -> dict[str, object]:
    assert result.isError
    assert result.structuredContent is not None
    text = result.content[0]
    assert isinstance(text, TextContent)
    assert json.loads(text.text) == result.structuredContent
    return result.structuredContent


@pytest.mark.asyncio
async def test_stdio_client_restart_conflicts_and_shared_content(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    home = tmp_path / "client-home"
    home.mkdir()
    source = str(Path(__file__).resolve().parents[1] / "src")
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home),
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "PYTHONPATH": os.pathsep.join(filter(None, [source, os.environ.get("PYTHONPATH", "")])),
        "SECOND_BRAIN_WIKI_VAULT": str(vault),
        "SECOND_BRAIN_WIKI_GRAPH_INDEX": "0",
        "SECOND_BRAIN_WIKI_VECTOR_INDEX": "0",
        "SECOND_BRAIN_WIKI_GIT_SYNC": "0",
        "SECOND_BRAIN_WIKI_DELIVERY": "1",
    }
    params = StdioServerParameters(
        command=sys.executable, args=["-m", "second_brain.wiki.mcp"], env=env, cwd=home
    )
    markdown = "# Harbor\n\nA fictional observatory: 海 / 😀 / Cafe\u0301 / مرحبا."
    args = {
        "id": "harbor",
        "markdown": markdown,
        "base_revision": None,
        "request_id": "stdio-créer-海-😀",
    }
    # The SDK owns and closes each real child, including on assertion/timeout.
    with anyio.fail_after(30):
        async with stdio_client(params) as (read, write), ClientSession(read, write) as client:
            initialized = await client.initialize()
            assert "wiki://guidance" in (initialized.instructions or "")
            tools = {tool.name for tool in (await client.list_tools()).tools}
            assert {"save_page", "delete_page", "get_page", "get_history"} <= tools
            assert not {"remember", "recall"} & tools
            guidance = await client.read_resource(AnyUrl("wiki://guidance"))
            content = guidance.contents[0]
            assert isinstance(content, TextResourceContents)
            assert "base_revision" in content.text
            created = await client.call_tool("save_page", args)
            assert not created.isError
            saved = created.structuredContent
            assert saved is not None
            status = (await client.call_tool("get_delivery_status")).structuredContent
            assert status is not None
            assert status["background_worker"]["state"] == "running"
            assert status["remote"]["state"] == "not_configured"

            external = WikiStore(vault)
            publication = external._head()
            assert external._blob(publication, "pages/harbor.md") == markdown.encode()
            replay = await client.call_tool("save_page", args)
            assert not replay.isError and replay.structuredContent == saved
            assert external._head() == publication
            with TestClient(create_app(vault)) as rest:
                assert rest.get("/api/wiki/pages/harbor").json()["revision"] == saved["revision"]
                assert rest.get("/api/wiki/pages/harbor").json()["markdown"] == args["markdown"]
                response = rest.post(
                    "/api/wiki/pages/harbor",
                    json={"markdown": "# Harbor\n\nUpdated outside MCP.",
                          "base_revision": saved["revision"], "request_id": "external-edit"},
                )
                assert response.status_code == 200
                newer = response.json()
            conflict = await client.call_tool(
                "save_page",
                {**args, "markdown": "# Stale", "base_revision": saved["revision"],
                 "request_id": "stdio-conflict"},
            )
            error = _error(conflict)
            assert error["error"] == "revision_conflict"
            assert error["current_revision"] == newer["revision"]
            reused = await client.call_tool("save_page", {**args, "markdown": "# Different"})
            assert _error(reused)["error"] == "request_id_reused"
            invalid = await client.call_tool("get_history", {"id": "../outside"})
            assert _error(invalid)["error"] == "invalid_id"

        async with stdio_client(params) as (read, write), ClientSession(read, write) as client:
            await client.initialize()
            # Model a lost reply by replaying after a completely fresh server.
            replay = await client.call_tool("save_page", args)
            assert not replay.isError
            assert replay.structuredContent == saved
            current = (await client.call_tool("get_page", {"id": "harbor"})).structuredContent
            assert current is not None
            assert current["revision"] == newer["revision"]
            assert current["markdown"] == "# Harbor\n\nUpdated outside MCP."
            delete_args = {
                "id": "harbor", "base_revision": newer["revision"], "request_id": "stdio-delete"
            }
            deleted = await client.call_tool("delete_page", delete_args)
            assert not deleted.isError
            assert deleted.structuredContent is not None

        async with stdio_client(params) as (read, write), ClientSession(read, write) as client:
            await client.initialize()
            replay_delete = await client.call_tool("delete_page", delete_args)
            assert not replay_delete.isError
            assert replay_delete.structuredContent == deleted.structuredContent
            missing = await client.call_tool("get_page", {"id": "harbor"})
            assert not missing.isError
            assert missing.structuredContent == {"error": "not_found", "id": "harbor"}
            history = await client.call_tool("get_history", {"id": "harbor"})
            assert not history.isError
            assert history.structuredContent is not None
            assert len(history.structuredContent["result"]) == 3
            pages = await client.call_tool("list_pages")
            assert not pages.isError
            assert pages.structuredContent == {"result": []}
            unconfigured = await client.call_tool(
                "search_wiki", {"query": "harbor", "mode": "semantic"}
            )
            assert _error(unconfigured)["error"] == "index_not_configured"
            unknown = await client.call_tool("search_wiki", {"query": "harbor", "mode": "other"})
            assert unknown.isError
            assert unknown.structuredContent is None

    assert external.get_page("harbor") is None
    assert len(external.history("harbor")) == 3
    with TestClient(create_app(vault)) as rest:
        assert rest.get("/api/wiki/pages/harbor").status_code == 404
