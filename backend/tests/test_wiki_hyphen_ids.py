"""Synthetic migration contracts for literal leading-hyphen page identities."""

# Native Git and private snapshot assertions establish preservation boundaries.
# ruff: noqa: S101, S603, SLF001
import json
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.exporter import export_vault
from second_brain.wiki.import_audit import audit_import
from second_brain.wiki.importer import import_vault
from second_brain.wiki.mcp import create_http_app, create_mcp
from second_brain.wiki.store import WikiError, WikiStore


def data(result: Any) -> dict[str, Any]:
    if isinstance(result, tuple):
        return cast(dict[str, Any], result[1])
    if isinstance(result, dict):
        return result
    return cast(dict[str, Any], json.loads(result[0].text))


def git(source: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(source), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.mark.parametrize("page_id", ["-synthetic-note", "--help"])
def test_hyphen_import_export_history_and_replay(tmp_path: Path, page_id: str) -> None:
    source = tmp_path / "source"
    source.mkdir()
    git(source, "init", "--quiet")
    git(source, "config", "user.name", "Synthetic Archive")
    git(source, "config", "user.email", "archive@example.invalid")
    prefix = source / "knowledge"
    prefix.mkdir()
    original = f"# Synthetic preserved identity\r\n\r\n[[home]] / Café 🌊 / {page_id}.\r\n".encode()
    (prefix / f"{page_id}.md").write_bytes(original)
    (prefix / "home.md").write_text(f"# Synthetic home\n\n[[{page_id}|Preserved note]]\n")
    git(source, "add", "--all")
    git(source, "commit", "--quiet", "-m", "Synthetic source")
    source_revision = git(source, "rev-parse", "HEAD")
    store = WikiStore(tmp_path / "managed")
    imported = import_vault(
        store, source, prefix="knowledge", base_revision=None, request_id="import"
    )
    assert (store.get_page(page_id) or {})["markdown"].encode() == original
    assert any(row["commit"] == source_revision for row in store.history(page_id))
    assert git(source, "rev-parse", "HEAD") == source_revision
    assert git(source, "status", "--porcelain") == ""
    assert (
        audit_import(store, source, prefix="knowledge", revision=imported["revision"])["status"]
        == "verified"
    )
    assert any(edge["target"] == page_id for edge in store.graph()["edges"])
    target = tmp_path / "export"
    assert export_vault(store, target, base_revision=imported["revision"])["page_count"] == 2
    assert (target / f"{page_id}.md").read_bytes() == original
    before = store.get_page(page_id) or {}
    saved = store.save_page(page_id, "# Synthetic edited note\n", before["revision"], "edit")
    assert (
        store.save_page(page_id, "# Synthetic edited note\n", before["revision"], "edit") == saved
    )
    deleted = store.delete_page(page_id, saved["revision"], "delete")
    assert WikiStore(store.path).delete_page(page_id, saved["revision"], "delete") == deleted
    assert store.get_page(page_id) is None
    assert store.history(page_id)


async def test_hyphen_rest_and_mcp_share_identity_and_conflicts(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    mcp = create_mcp(store)
    with TestClient(create_app(tmp_path)) as client:
        saved = client.post(
            "/api/wiki/pages/--help",
            json={
                "markdown": "# Synthetic HTTP identity",
                "base_revision": None,
                "request_id": "rest",
            },
        )
        assert saved.status_code == 200
        revision = saved.json()["revision"]
        read = data(await mcp.call_tool("get_page", {"id": "--help"}))
        # FastMCP returns text plus structured content for its direct tool API.
        assert read["id"] == "--help"
        assert read["revision"] == revision
        updated = data(
            await mcp.call_tool(
                "save_page",
                {
                    "id": "--help",
                    "markdown": "# Synthetic MCP update",
                    "base_revision": revision,
                    "request_id": "mcp",
                },
            )
        )
        assert updated["publication"] == "saved"
        assert client.get("/api/wiki/pages/--help").json()["markdown"] == "# Synthetic MCP update"
        conflict = client.post(
            "/api/wiki/pages/--help",
            json={
                "markdown": "# Stale",
                "base_revision": revision,
                "request_id": "conflict",
            },
        )
        assert conflict.status_code == 409
        assert client.get("/api/wiki/pages/--help/history").status_code == 200

    headers = {
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer synthetic-key",
    }
    with TestClient(
        create_http_app(store, "synthetic-key"), base_url="http://localhost", headers=headers
    ) as native:
        initialized = native.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "synthetic-hyphen-test", "version": "1"},
                },
            },
        )
        assert initialized.status_code == 200
        assert "serverInfo" in initialized.json()["result"]
        assert (
            native.post(
                "/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}
            ).status_code
            == 202
        )
        read_http = native.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {
                    "name": "get_page",
                    "arguments": {"id": "--help"},
                },
            },
        )
        assert read_http.status_code == 200
        assert read_http.json()["result"]["structuredContent"]["id"] == "--help"
        assert (
            read_http.json()["result"]["structuredContent"]["markdown"] == "# Synthetic MCP update"
        )


@pytest.mark.parametrize("page_id", ["-", "-café", "-" + "a" * 159])
def test_hyphen_boundaries_are_literal_page_ids(tmp_path: Path, page_id: str) -> None:
    store = WikiStore(tmp_path)
    saved = store.save_page(page_id, "# Synthetic literal ID", None, "boundary")
    assert (store.get_page(page_id) or {})["revision"] == saved["revision"]
    assert len(store.history(page_id)) == 1


@pytest.mark.parametrize(
    "page_id",
    [
        ".",
        "..",
        ".hidden",
        "-../escape",
        "-a/b",
        "-a\\b",
        "-a\nheader",
        "-a b",
        "-a:option",
        "-" + "a" * 160,
    ],
)
def test_hyphen_does_not_weaken_invalid_identity_guard(tmp_path: Path, page_id: str) -> None:
    store = WikiStore(tmp_path)
    with pytest.raises(WikiError) as error:
        store.save_page(page_id, "# Synthetic unsafe ID", None, "unsafe")
    assert error.value.code == "invalid_id"
    assert store.snapshot()["pages"] == []
