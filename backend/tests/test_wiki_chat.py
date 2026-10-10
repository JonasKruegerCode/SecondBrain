from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from second_brain.core.config import settings
from second_brain.llm.providers.openrouter.client import OpenRouterClient
from second_brain.wiki.api import create_app
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


class ScriptedProvider:
    def __init__(self, replies: list[dict[str, Any]]) -> None:
        self.replies = replies
        self.requests: list[list[dict[str, Any]]] = []

    async def tool_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int = 1200,
    ) -> dict[str, Any]:
        self.requests.append(messages.copy())
        return self.replies.pop(0)


def call(name: str, arguments: str, call_id: str) -> dict[str, Any]:
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": arguments},
    }


def configured_app(tmp_path: Path, provider: ScriptedProvider) -> Any:
    store = WikiStore(tmp_path)
    indexes = IndexCoordinator(store)
    chat = WikiChat(store, indexes, provider)
    return create_app(tmp_path, indexes=indexes, chat=chat)


def test_chat_iterates_over_real_search_and_page_services(tmp_path: Path) -> None:
    provider = ScriptedProvider(
        [
            {"content": None, "tool_calls": [call("search_wiki", '{"query":"harbor"}', "s1")]},
            {"content": None, "tool_calls": [call("read_page", '{"page_id":"harbor"}', "r1")]},
            {"content": "The harbor uses a solar beacon.", "tool_calls": []},
        ]
    )
    with TestClient(configured_app(tmp_path, provider)) as client:
        assert (
            client.post(
                "/api/wiki/pages/harbor",
                json={
                    "markdown": "# Harbor\nThe fictional harbor uses a solar beacon.",
                    "base_revision": None,
                    "request_id": "seed-harbor",
                },
            ).status_code
            == 200
        )
        response = client.post(
            "/api/wiki/chat", json={"messages": [{"role": "user", "content": "What guides ships?"}]}
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    assert result["answer"] == "The harbor uses a solar beacon."
    assert result["sources"] == [{"id": "harbor", "title": "Harbor", "evidence": "read"}]
    assert result["limits"] == {"tool_calls": 2, "max_tool_calls": 8}
    assert [entry["role"] for entry in provider.requests[-1]][-4:] == [
        "assistant",
        "tool",
        "assistant",
        "tool",
    ]
    assert "solar beacon" in provider.requests[-1][-1]["content"]


def test_chat_rejects_write_tools_and_keeps_page_unchanged(tmp_path: Path) -> None:
    provider = ScriptedProvider(
        [
            {
                "content": None,
                "tool_calls": [
                    call(
                        "save_page",
                        '{"page_id":"harbor","markdown":"# Changed"}',
                        "w1",
                    )
                ],
            },
            {"content": "I cannot change the wiki from chat.", "tool_calls": []},
        ]
    )
    with TestClient(configured_app(tmp_path, provider)) as client:
        client.post(
            "/api/wiki/pages/harbor",
            json={
                "markdown": "# Harbor\nOriginal.",
                "base_revision": None,
                "request_id": "seed",
            },
        )
        response = client.post(
            "/api/wiki/chat", json={"messages": [{"role": "user", "content": "Change it"}]}
        )
        page = client.get("/api/wiki/pages/harbor").json()
    assert response.status_code == 200
    assert page["markdown"] == "# Harbor\nOriginal."
    assert "unknown_read_only_tool" in provider.requests[-1][-1]["content"]


def test_chat_validates_origin_context_and_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = ScriptedProvider([{"content": "Hello", "tool_calls": []}])
    with TestClient(configured_app(tmp_path, provider)) as client:
        assert client.post("/api/wiki/chat", json={"messages": []}).status_code == 400
        assert (
            client.post(
                "/api/wiki/chat",
                json={"messages": [{"role": "assistant", "content": "not a user turn"}]},
            ).status_code
            == 400
        )
        assert (
            client.post(
                "/api/wiki/chat",
                json={"messages": [{"role": "user", "content": "Hello"}]},
                headers={"Origin": "https://unrelated.example"},
            ).status_code
            == 403
        )

    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "")
    with TestClient(create_app(tmp_path / "unconfigured")) as client:
        unavailable = client.post(
            "/api/wiki/chat",
            json={"messages": [{"role": "user", "content": "Hello"}]},
        )
    assert unavailable.status_code == 503
    assert unavailable.json()["error"] == "chat_unavailable"


@pytest.mark.asyncio
async def test_openrouter_tool_chat_preserves_structured_calls(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "synthetic-test-key")
    client = OpenRouterClient()
    expected = {
        "content": None,
        "tool_calls": [call("read_page", '{"page_id":"harbor"}', "r1")],
    }

    async def response(payload: dict[str, Any]) -> dict[str, Any]:
        assert payload["tool_choice"] == "auto"
        assert payload["messages"][-1]["content"] == "Find the harbor"
        return {"choices": [{"message": expected}]}

    monkeypatch.setattr(client, "_post_json_with_retry", response)
    result = await client.tool_chat(
        [{"role": "user", "content": "Find the harbor"}], WikiChat.tools()
    )
    assert result == expected
