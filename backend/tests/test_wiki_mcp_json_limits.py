"""Reject malformed and oversized MCP bodies before SDK dispatch."""

import asyncio
import json
from pathlib import Path

import pytest
from starlette.testclient import TestClient
from starlette.types import Message, Receive, Scope, Send

from second_brain.wiki.mcp import _HttpBoundary, create_http_app
from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize(
    "body,status",
    [
        (b'{"invalid":"\xff"}', 400),
        (("[" * 11_000 + "0" + "]" * 11_000).encode(), 400),
        (b" " * 1_100_001, 413),
    ],
    ids=["invalid-utf8", "decoder-depth", "oversized-body"],
)
def test_invalid_body_preserves_store_and_sdk_remains_usable(
    tmp_path: Path,
    body: bytes,
    status: int,
) -> None:
    store = WikiStore(tmp_path)
    store.save_page("synthetic", "# Synthetic\nInvented fixture.", None, "seed")
    snapshot, history = store.snapshot(), store.history("synthetic")
    with TestClient(
        create_http_app(store, "synthetic-key"),
        base_url="http://localhost:8000",
        raise_server_exceptions=False,
        headers={
            "Authorization": "Bearer synthetic-key",
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        },
    ) as client:
        rejected = client.post("/mcp", content=body)
        assert rejected.status_code == status
        assert rejected.headers["cache-control"] == "no-store"
        assert rejected.json()["error"]["code"] == (-32700 if status == 400 else -32600)
        # A fresh, ordinary SDK request still works after rejected input.
        valid = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert valid.status_code == 200
        assert any(tool["name"] == "save_page" for tool in valid.json()["result"]["tools"])
    assert store.snapshot() == snapshot
    assert store.history("synthetic") == history


@pytest.mark.parametrize("case", ["chunked", "at-limit", "oversized", "unauthorized"])
def test_stream_boundary_counts_actual_bytes_and_preserves_receive(case: str) -> None:
    async def exercise() -> None:
        reads = 0
        dispatched = False
        sent: list[Message] = []
        chunks = [b"{", b"}"] if case == "chunked" else [b" " * 600_000] * 2
        if case == "at-limit":
            chunks = [b" " * 550_000, b" " * 549_998 + b"{}"]

        async def receive() -> Message:
            nonlocal reads
            reads += 1
            if reads <= len(chunks):
                return {
                    "type": "http.request",
                    "body": chunks[reads - 1],
                    "more_body": reads < len(chunks),
                }
            return {"type": "http.disconnect"}

        async def send(message: Message) -> None:
            sent.append(message)

        async def downstream(scope: Scope, incoming: Receive, output: Send) -> None:
            nonlocal dispatched
            dispatched = True
            message = await incoming()
            assert message["type"] == "http.request" and message["more_body"] is False
            assert message["body"] == b"".join(chunks)
            assert json.loads(message["body"]) == {}
            assert await incoming() == {"type": "http.disconnect"}
            await output({"type": "http.response.start", "status": 200, "headers": []})
            await output({"type": "http.response.body", "body": b"ok"})

        boundary = _HttpBoundary(
            downstream, api_key="synthetic-key", allowed_hosts=("localhost",), allowed_origins=()
        )
        token = b"wrong" if case == "unauthorized" else b"synthetic-key"
        scope: Scope = {
            "type": "http",
            "method": "POST",
            "headers": [
                (b"host", b"localhost"),
                (b"authorization", b"Bearer " + token),
                (b"content-length", b"2"),
            ],
        }
        await boundary(scope, receive, send)
        expected = {"chunked": 200, "at-limit": 200, "oversized": 413, "unauthorized": 401}[case]
        assert sent[0]["status"] == expected
        assert (b"cache-control", b"no-store") in sent[0]["headers"]
        assert dispatched == (expected == 200)
        assert reads == {"chunked": 3, "at-limit": 3, "oversized": 2, "unauthorized": 0}[case]

    asyncio.run(exercise())
