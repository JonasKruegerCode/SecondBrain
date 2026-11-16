"""Exercise disconnects through real ASGI receive, without external providers."""

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.api import create_app
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


class HeldProvider:
    def __init__(self) -> None:
        self.started: dict[str, asyncio.Event] = {}
        self.release: dict[str, asyncio.Event] = {}
        self.cancelled: set[str] = set()
        self.finished: set[str] = set()

    async def tool_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int = 1200,
    ) -> dict[str, Any]:
        key = messages[-1]["content"]
        self.release.setdefault(key, asyncio.Event())
        self.started.setdefault(key, asyncio.Event()).set()
        try:
            await self.release[key].wait()
            return {"content": f"Answer for {key}", "tool_calls": []}
        except asyncio.CancelledError:
            self.cancelled.add(key)
            raise
        finally:
            self.finished.add(key)

    async def wait_started(self, key: str) -> None:
        await asyncio.wait_for(self.started.setdefault(key, asyncio.Event()).wait(), 2)


class ASGIRequest:
    def __init__(self, app: Any, key: str) -> None:
        self.incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.incoming.put_nowait(
            {
                "type": "http.request",
                "more_body": False,
                "body": json.dumps({"messages": [{"role": "user", "content": key}]}).encode(),
            }
        )
        self.sent: list[dict[str, Any]] = []
        self.receiving = 0
        self.app = app

    async def receive(self) -> dict[str, Any]:
        self.receiving += 1
        try:
            return await self.incoming.get()
        finally:
            self.receiving -= 1

    async def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    async def run(self) -> None:
        await self.app(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "POST",
                "scheme": "http",
                "path": "/api/wiki/chat",
                "raw_path": b"/api/wiki/chat",
                "query_string": b"",
                "root_path": "",
                "headers": [(b"host", b"testserver")],
                "client": ("127.0.0.1", 1234),
                "server": ("testserver", 80),
            },
            self.receive,
            self.send,
        )

    def disconnect(self) -> None:
        self.incoming.put_nowait({"type": "http.disconnect"})


def configured_app(tmp_path: Path, provider: HeldProvider) -> Any:
    store = WikiStore(tmp_path)
    indexes = IndexCoordinator(store)
    return create_app(tmp_path, indexes=indexes, chat=WikiChat(store, indexes, provider))


@pytest.mark.asyncio
async def test_disconnect_cancels_only_its_provider_invocation(tmp_path: Path) -> None:
    provider = HeldProvider()
    app = configured_app(tmp_path, provider)
    stopped, active = ASGIRequest(app, "stopped"), ASGIRequest(app, "active")
    stopped_task, active_task = (
        asyncio.create_task(stopped.run()),
        asyncio.create_task(active.run()),
    )
    try:
        await provider.wait_started("stopped")
        await provider.wait_started("active")
        stopped.disconnect()
        await asyncio.wait_for(stopped_task, 2)
        assert provider.cancelled == {"stopped"}
        assert provider.finished == {"stopped"}
        assert stopped.receiving == 0
        assert not active_task.done()
        provider.release["active"].set()
        await asyncio.wait_for(active_task, 2)
        assert active.receiving == 0
        start = next(message for message in active.sent if message["type"] == "http.response.start")
        assert start["status"] == 200
        assert (b"cache-control", b"no-store") in start["headers"]
        payload = b"".join(message.get("body", b"") for message in active.sent)
        assert json.loads(payload)["answer"] == "Answer for active"
        assert provider.cancelled == {"stopped"}
    finally:
        stopped_task.cancel()
        active_task.cancel()
        await asyncio.gather(stopped_task, active_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_request_cancellation_propagates_and_cleans_up(tmp_path: Path) -> None:
    provider = HeldProvider()
    request = ASGIRequest(configured_app(tmp_path, provider), "cancelled")
    task = asyncio.create_task(request.run())
    await provider.wait_started("cancelled")
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2)
    assert provider.cancelled == {"cancelled"}
    assert provider.finished == {"cancelled"}
    assert request.receiving == 0


@pytest.mark.asyncio
async def test_timeout_cancels_provider_and_returns_clean_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = HeldProvider()
    request = ASGIRequest(configured_app(tmp_path, provider), "timeout")
    original_timeout = asyncio.timeout
    durations: list[float | None] = []

    def short_timeout(delay: float | None) -> asyncio.Timeout:
        durations.append(delay)
        return original_timeout(0.01)

    monkeypatch.setattr(asyncio, "timeout", short_timeout)
    await asyncio.wait_for(request.run(), 2)
    assert durations == [55]
    assert provider.cancelled == {"timeout"}
    assert provider.finished == {"timeout"}
    assert request.receiving == 0
    start = next(message for message in request.sent if message["type"] == "http.response.start")
    assert start["status"] == 503
    assert (b"cache-control", b"no-store") in start["headers"]
    payload = b"".join(message.get("body", b"") for message in request.sent)
    assert json.loads(payload) == {
        "error": "chat_unavailable",
        "message": "Wiki chat timed out. Try again.",
    }
