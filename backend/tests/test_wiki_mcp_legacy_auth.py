"""Preserve configured MCP credentials without importing old secret-discovery routes."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from second_brain.wiki.api import app_factory
from second_brain.wiki.mcp import _HttpBoundary, create_http_app, http_app_factory
from second_brain.wiki.store import WikiStore

KEY = "synthetic-legacy-key"
HEADERS = {"Accept": "application/json, text/event-stream"}
BODY = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.startswith(("SECOND_BRAIN_WIKI_", "VAULT_")) or name == "MCP_API_KEY":
            monkeypatch.delenv(name)
    launch = tmp_path / "launch"
    launch.mkdir()
    monkeypatch.chdir(launch)
    monkeypatch.setenv("SECOND_BRAIN_WIKI_VAULT", str(tmp_path / "vault"))
    monkeypatch.setenv("SECOND_BRAIN_WIKI_DELIVERY", "0")


@pytest.mark.parametrize("dotenv", [False, True])
def test_factory_keeps_old_env_and_dotenv_key_without_protecting_browser_rest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, dotenv: bool
) -> None:
    if dotenv:
        Path(".env").write_text("MCP_API_KEY=" + KEY + "\n")
    else:
        monkeypatch.setenv("MCP_API_KEY", KEY)
    with TestClient(http_app_factory(), base_url="http://localhost") as client:
        assert client.post("/mcp", json=BODY, headers=HEADERS).status_code == 401
        result = client.post("/mcp", json=BODY, headers={**HEADERS, "X-API-Key": KEY})
        assert result.status_code == 200
        assert "tools" in result.json()["result"]
        assert result.headers["cache-control"] == "no-store"
        assert client.post("/mcp?api_key=" + KEY, json=BODY).status_code == 200
        assert client.get("/register", headers={"X-API-Key": KEY}).status_code == 404
    with TestClient(app_factory()) as rest:
        assert rest.get("/api/wiki/health").status_code == 200


@pytest.mark.parametrize("scheme", ["Bearer", "bearer", "BEARER"])
def test_bearer_scheme_is_case_insensitive(tmp_path: Path, scheme: str) -> None:
    with TestClient(
        create_http_app(WikiStore(tmp_path / "manual"), KEY), base_url="http://localhost"
    ) as client:
        result = client.post(
            "/mcp", json=BODY, headers={**HEADERS, "Authorization": scheme + " " + KEY}
        )
        assert result.status_code == 200


def test_explicit_new_key_wins_and_remains_bearer_only(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_API_KEY", KEY)
    monkeypatch.setenv("SECOND_BRAIN_WIKI_API_KEY", "synthetic-new-key")
    with TestClient(http_app_factory(), base_url="http://localhost") as client:
        assert client.post("/mcp?api_key=" + KEY, json=BODY, headers=HEADERS).status_code == 401
        assert (
            client.post(
                "/mcp", json=BODY, headers={**HEADERS, "X-API-Key": "synthetic-new-key"}
            ).status_code
            == 401
        )
        assert (
            client.post(
                "/mcp", json=BODY, headers={**HEADERS, "Authorization": "bearer synthetic-new-key"}
            ).status_code
            == 200
        )


@pytest.mark.parametrize("root_path", ["", "/proxy-prefix"])
def test_legacy_url_key_with_trailing_slash_does_not_redirect_or_lose_auth(
    monkeypatch: pytest.MonkeyPatch, root_path: str
) -> None:
    monkeypatch.setenv("MCP_API_KEY", KEY)
    with TestClient(
        http_app_factory(), base_url="http://localhost", root_path=root_path
    ) as client:
        url = root_path + "/mcp/?keep=visible&api_key="
        result = client.post(url + KEY, json=BODY, follow_redirects=False)
        assert result.status_code == 200
        assert "tools" in result.json()["result"]
        assert "location" not in result.headers
        assert KEY not in result.text
        rejected = client.post(url + "wrong", json=BODY, follow_redirects=False)
        assert rejected.status_code == 401
        assert "location" not in rejected.headers


@pytest.mark.parametrize(
    "headers,query",
    [
        ({"X-API-Key": "wrong", "Authorization": "Bearer " + KEY}, "api_key=" + KEY),
        ({"Authorization": "Bearer wrong"}, "api_key=" + KEY),
    ],
)
def test_legacy_precedence_rejects_wrong_higher_priority_credentials(
    monkeypatch: pytest.MonkeyPatch, headers: dict[str, str], query: str
) -> None:
    monkeypatch.setenv("MCP_API_KEY", KEY)
    with TestClient(http_app_factory(), base_url="http://localhost") as client:
        assert (
            client.post("/mcp?" + query, json=BODY, headers={**HEADERS, **headers}).status_code
            == 401
        )


def test_legacy_auth_retains_host_origin_and_body_guards(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_API_KEY", KEY)
    with TestClient(http_app_factory(), base_url="http://localhost") as client:
        headers = {**HEADERS, "X-API-Key": KEY}
        assert (
            client.post("/mcp", json=BODY, headers={**headers, "Host": "evil.invalid"}).status_code
            == 421
        )
        assert (
            client.post(
                "/mcp", json=BODY, headers={**headers, "Origin": "https://evil.invalid"}
            ).status_code
            == 403
        )
        assert client.post("/mcp", content=b"x" * 1_100_001, headers=headers).status_code == 413


@pytest.mark.parametrize("provided", [KEY, "synthetic-wrong-key"])
def test_query_secret_is_removed_from_shared_scope_even_on_rejection(provided: str) -> None:
    import asyncio

    scope: dict[str, Any] = {
        "type": "http",
        "method": "GET",
        "path": "/mcp",
        "query_string": ("keep=visible&api_key=" + provided).encode(),
        "headers": [(b"host", b"localhost")],
    }
    sent: list[dict[str, Any]] = []

    async def downstream(scope: Any, receive: Any, send: Any) -> None:
        assert scope["query_string"] == b"keep=visible"
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    async def receive() -> Any:
        return {"type": "http.disconnect"}

    async def send(message: Any) -> None:
        sent.append(message)

    boundary = _HttpBoundary(
        downstream, api_key=KEY, allowed_hosts=("localhost",), allowed_origins=(), legacy_auth=True
    )
    asyncio.run(boundary(scope, receive, send))
    assert scope["query_string"] == b"keep=visible"
    assert sent[0]["status"] == (200 if provided == KEY else 401)
    assert provided not in repr(sent)
