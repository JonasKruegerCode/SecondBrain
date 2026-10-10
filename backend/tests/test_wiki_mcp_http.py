"""Real in-process FastMCP Streamable HTTP, without service/model mocks."""

from pathlib import Path
from typing import Any, cast

import pytest
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.mcp import GUIDANCE, create_http_app, http_app_factory
from second_brain.wiki.store import WikiStore

HEADERS = {"Accept": "application/json, text/event-stream"}


def rpc(
    client: TestClient, method: str, params: dict[str, Any] | None = None, id: int = 1
) -> dict[str, Any]:
    response = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params or {},
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "error" not in body, body
    return cast(dict[str, Any], body["result"])


def test_http_initialize_tools_guidance_and_shared_rest_content(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    app = create_http_app(store, "synthetic-test-key")
    headers = {**HEADERS, "Authorization": "Bearer synthetic-test-key"}
    with TestClient(app, base_url="http://localhost:8000", headers=headers) as client:
        initialized = rpc(
            client,
            "initialize",
            {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "managed-http-test", "version": "1"},
            },
        )
        assert initialized["serverInfo"]["name"] == "Second Brain Managed Wiki"
        assert "wiki://guidance" in initialized["instructions"]
        assert (
            client.post(
                "/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "notifications/initialized",
                },
            ).status_code
            == 202
        )
        tools = rpc(client, "tools/list")["tools"]
        assert {tool["name"] for tool in tools} == {
            "get_page",
            "list_pages",
            "search_wiki",
            "get_graph",
            "save_page",
            "delete_page",
            "get_history",
        }
        guidance = rpc(client, "resources/read", {"uri": "wiki://guidance"})
        assert guidance["contents"][0]["text"] == GUIDANCE
        args = {
            "id": "http-fixture",
            "markdown": "# HTTP fixture\nSynthetic text.",
            "base_revision": None,
            "request_id": "http-create",
        }
        result = rpc(client, "tools/call", {"name": "save_page", "arguments": args})
        assert not result.get("isError", False)
        saved = result["structuredContent"]
        assert saved["publication"] == "saved"
        assert saved["remote_sync"] == "not_configured"
        retry = rpc(client, "tools/call", {"name": "save_page", "arguments": args})
        assert retry["structuredContent"]["revision"] == saved["revision"]
        fetched = rpc(
            client,
            "tools/call",
            {
                "name": "get_page",
                "arguments": {
                    "id": "http-fixture",
                },
            },
        )
        assert fetched["structuredContent"]["revision"] == saved["revision"]
        conflict = rpc(
            client,
            "tools/call",
            {
                "name": "save_page",
                "arguments": {
                    **args,
                    "request_id": "http-conflict",
                    "markdown": "# Stale",
                    "base_revision": "old",
                },
            },
        )
        assert conflict["isError"] is True
        assert (store.get_page("http-fixture") or {})["markdown"] == args["markdown"]
        assert (
            client.post(
                "/mcp/",
                json={"jsonrpc": "2.0", "id": 9, "method": "tools/list"},
                follow_redirects=False,
            ).status_code
            == 307
        )
        assert (
            client.post(
                "/mcp/", json={"jsonrpc": "2.0", "id": 10, "method": "tools/list"}
            ).status_code
            == 200
        )
        assert client.get("/register").status_code == 404
    with TestClient(create_app(tmp_path)) as rest:
        assert rest.get("/api/wiki/pages/http-fixture").json()["revision"] == saved["revision"]


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong"},
        {"X-API-Key": "synthetic-test-key"},
    ],
)
def test_http_bearer_required_and_never_echoes_key(tmp_path: Path, headers: dict[str, str]) -> None:
    app = create_http_app(WikiStore(tmp_path), "synthetic-test-key")
    with TestClient(app, base_url="http://localhost:8000") as client:
        response = client.post("/mcp?api_key=synthetic-test-key", headers=headers, json={})
        assert response.status_code == 401
        assert "synthetic-test-key" not in response.text
        assert response.headers["www-authenticate"].startswith("Bearer")
        assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("headers", "status"),
    [
        ({"Host": "evil.example"}, 421),
        ({"Host": "localhost:8000.evil.example"}, 421),
        ({"Host": "localhost:8000@evil.example"}, 421),
        ({"Origin": "https://evil.example"}, 403),
        ({"Origin": "http://localhost:8000.evil.example"}, 403),
        ({"Origin": "null"}, 403),
        ({"Origin": "http://localhost:8000/path"}, 403),
    ],
)
def test_http_dns_rebinding_and_origins_rejected(
    tmp_path: Path, headers: dict[str, str], status: int
) -> None:
    with TestClient(
        create_http_app(WikiStore(tmp_path)), base_url="http://localhost:8000", headers=HEADERS
    ) as client:
        response = client.post("/mcp", headers=headers, json={})
        assert response.status_code == status


def test_http_explicit_proxy_authority_and_origin_are_independent(tmp_path: Path) -> None:
    app = create_http_app(
        WikiStore(tmp_path),
        "test-key",
        allowed_hosts=("internal:3000",),
        allowed_origins=("https://wiki.example",),
    )
    with TestClient(
        app,
        base_url="http://internal:3000",
        headers={
            **HEADERS,
            "Authorization": "Bearer test-key",
            "Origin": "https://wiki.example",
        },
    ) as client:
        assert "tools" in rpc(client, "tools/list")
        assert (
            client.post("/mcp", headers={"Origin": "https://other.example"}, json={}).status_code
            == 403
        )
        assert client.post("/mcp", headers={"Host": "other.example"}, json={}).status_code == 421


def test_http_factory_requires_explicit_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SECOND_BRAIN_WIKI_VAULT", raising=False)
    with pytest.raises(RuntimeError, match="SECOND_BRAIN_WIKI_VAULT"):
        http_app_factory()
    with pytest.raises(ValueError, match="wildcard"):
        create_http_app(None, allowed_hosts=("*",))  # type: ignore[arg-type]
