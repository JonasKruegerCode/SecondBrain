"""Incomplete provider choices must not become answers or tool executions."""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from starlette.testclient import TestClient

from second_brain.core.config import settings
from second_brain.llm.providers.openrouter.client import OpenRouterClient, OpenRouterError
from second_brain.wiki.api import create_app
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


def provider_with_choices(
    monkeypatch: pytest.MonkeyPatch, choices: list[dict[str, Any]]
) -> tuple[OpenRouterClient, list[dict[str, Any]]]:
    """Use the real HTTP/JSON client with a synthetic, non-network transport."""
    requests: list[dict[str, Any]] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [choices.pop(0)]})

    original_client = httpx.AsyncClient
    transport = httpx.MockTransport(respond)

    def client(**kwargs: Any) -> httpx.AsyncClient:
        return original_client(**kwargs, transport=transport)

    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "synthetic-test-key")
    monkeypatch.setattr(httpx, "AsyncClient", client)
    return OpenRouterClient(), requests


@pytest.mark.parametrize(
    "finish", ["length", "content_filter", "error", None, "unknown", 42, [], {}]
)
@pytest.mark.asyncio
async def test_noncompleted_choice_is_rejected_without_an_automatic_retry(
    monkeypatch: pytest.MonkeyPatch, finish: Any
) -> None:
    provider, requests = provider_with_choices(
        monkeypatch,
        [{"finish_reason": finish, "message": {"content": "Synthetic partial answer."}}],
    )
    with pytest.raises(OpenRouterError):
        await provider.tool_chat([{"role": "user", "content": "A question"}], WikiChat.tools())
    assert len(requests) == 1
    assert requests[0]["max_tokens"] == 1200


@pytest.mark.asyncio
async def test_missing_completion_status_is_not_assumed_successful(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider, requests = provider_with_choices(
        monkeypatch, [{"message": {"content": "Synthetic partial answer."}}]
    )
    with pytest.raises(OpenRouterError):
        await provider.tool_chat([{"role": "user", "content": "A question"}], WikiChat.tools())
    assert len(requests) == 1


@pytest.mark.parametrize("finish", ["stop", "tool_calls"])
@pytest.mark.asyncio
async def test_completed_choice_preserves_the_original_assistant_message(
    monkeypatch: pytest.MonkeyPatch, finish: str
) -> None:
    message: dict[str, Any] = {"role": "assistant", "content": "Synthetic complete answer."}
    if finish == "tool_calls":
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "read-1",
                    "type": "function",
                    "function": {"name": "read_page", "arguments": '{"page_id":"harbor"}'},
                }
            ],
        }
    provider, requests = provider_with_choices(
        monkeypatch, [{"finish_reason": finish, "message": message}]
    )
    assert (
        await provider.tool_chat([{"role": "user", "content": "A question"}], WikiChat.tools())
        == message
    )
    assert len(requests) == 1


@pytest.mark.parametrize("tool_batch", [False, True], ids=["answer", "tools"])
def test_api_rejects_partial_choice_and_allows_deliberate_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, tool_batch: bool
) -> None:
    partial: dict[str, Any] = {"content": "Synthetic partial answer must not escape."}
    if tool_batch:
        partial["tool_calls"] = [
            {
                "id": "partial-read",
                "type": "function",
                "function": {"name": "read_page", "arguments": '{"page_id":"harbor"}'},
            }
        ]
    provider, requests = provider_with_choices(
        monkeypatch,
        [
            {"finish_reason": "length", "message": partial},
            {"finish_reason": "stop", "message": {"content": "Synthetic complete answer."}},
        ],
    )
    store = WikiStore(tmp_path)
    store.save_page("harbor", "# Harbor\nOriginal.", base_revision=None, request_id="seed")
    indexes = IndexCoordinator(store)
    chat = WikiChat(store, indexes, provider)
    calls: list[Any] = []

    def unexpected_tool(*args: Any, **kwargs: Any) -> dict[str, Any]:
        calls.append(args)
        return {"error": "synthetic_unexpected_tool"}

    monkeypatch.setattr(chat, "_execute", unexpected_tool)
    payload = {"messages": [{"role": "user", "content": "A synthetic question"}]}
    with TestClient(create_app(tmp_path, indexes=indexes, chat=chat)) as client:
        response = client.post("/api/wiki/chat", json=payload)
        assert response.status_code == 503
        assert response.headers["cache-control"] == "no-store"
        assert response.json() == {
            "error": "chat_unavailable",
            "message": "The model provider is temporarily unavailable.",
        }
        assert len(requests) == 1 and not calls
        assert client.get("/api/wiki/pages/harbor").json()["markdown"] == "# Harbor\nOriginal."
        retried = client.post("/api/wiki/chat", json=payload)
        assert retried.status_code == 200
        assert retried.json()["answer"] == "Synthetic complete answer."
        assert retried.json()["sources"] == []
        assert len(requests) == 2 and requests[0] == requests[1]
        assert len(store.history("harbor")) == 1
