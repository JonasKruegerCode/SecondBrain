import json
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from second_brain.core.config import settings
from second_brain.llm.providers.openrouter.client import OpenRouterClient
from second_brain.wiki.api import create_app
from second_brain.wiki.chat import MAX_ROUNDS, MAX_TOOL_RESULT_CHARS, WikiChat
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


def test_chat_does_not_cite_unread_search_hits(tmp_path: Path) -> None:
    provider = ScriptedProvider(
        [
            {"content": None, "tool_calls": [call("search_wiki", '{"query":"harbor"}', "s1")]},
            {"content": "I found a possible match but did not open it.", "tool_calls": []},
        ]
    )
    with TestClient(configured_app(tmp_path, provider)) as client:
        for page_id, title in (("harbor", "Harbor"), ("harbor-log", "Harbor log")):
            assert (
                client.post(
                    f"/api/wiki/pages/{page_id}",
                    json={
                        "markdown": f"# {title}\nA fictional harbor record.",
                        "base_revision": None,
                        "request_id": f"seed-{page_id}",
                    },
                ).status_code
                == 200
            )
        response = client.post(
            "/api/wiki/chat", json={"messages": [{"role": "user", "content": "Find harbor"}]}
        )

    assert response.status_code == 200
    result = response.json()
    assert result["sources"] == []
    assert result["activity"] == ["Searched the wiki for “harbor”."]
    assert "harbor-log" in provider.requests[-1][-1]["content"]


def test_chat_keeps_truncated_page_tool_result_valid_json(tmp_path: Path) -> None:
    provider = ScriptedProvider(
        [
            {"content": None, "tool_calls": [call("read_page", '{"page_id":"archive"}', "r1")]},
            {"content": "The archive is too long to quote in full.", "tool_calls": []},
        ]
    )
    markdown = "# Archive\n" + ('A quoted \\\"line\\\".\n' * 1_000)
    with TestClient(configured_app(tmp_path, provider)) as client:
        assert (
            client.post(
                "/api/wiki/pages/archive",
                json={
                    "markdown": markdown,
                    "base_revision": None,
                    "request_id": "seed-archive",
                },
            ).status_code
            == 200
        )
        response = client.post(
            "/api/wiki/chat", json={"messages": [{"role": "user", "content": "Read it"}]}
        )

    assert response.status_code == 200
    tool_message = provider.requests[-1][-1]
    assert tool_message["role"] == "tool"
    assert len(tool_message["content"]) <= MAX_TOOL_RESULT_CHARS
    result = json.loads(tool_message["content"])
    assert result["id"] == "archive"
    assert result["truncated"] is True
    assert result["markdown"].startswith("# Archive")
    assert len(result["markdown"]) < len(markdown)
    assert response.json()["sources"] == [{"id": "archive", "title": "Archive", "evidence": "read"}]


def test_chat_bounds_oversized_page_metadata_without_citing_it(tmp_path: Path) -> None:
    provider = ScriptedProvider(
        [
            {"tool_calls": [call("read_page", '{"page_id":"archive"}', "r1")]},
            {"content": "The page could not fit in context."},
        ]
    )
    with TestClient(configured_app(tmp_path, provider)) as client:
        assert client.post(
            "/api/wiki/pages/archive",
            json={
                "markdown": "# " + "T" * 9_000 + "\nEvidence.",
                "base_revision": None,
                "request_id": "seed-oversized-title",
            },
        ).status_code == 200
        response = client.post(
            "/api/wiki/chat", json={"messages": [{"role": "user", "content": "Read it"}]}
        )

    assert response.status_code == 200
    content = provider.requests[-1][-1]["content"]
    assert len(content) <= MAX_TOOL_RESULT_CHARS
    assert json.loads(content)["error"] == "tool_result_too_large"
    assert response.json()["sources"] == []


@pytest.mark.parametrize("bad_id", [None, "", " ", 42, "duplicate"])
def test_chat_rejects_invalid_call_ids_before_reading(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad_id: Any
) -> None:
    first = call("read_page", '{"page_id":"archive"}', "duplicate")
    second = call("read_page", '{"page_id":"archive"}', "placeholder")
    if bad_id is None:
        second.pop("id")
    else:
        second["id"] = bad_id
    provider = ScriptedProvider([{"tool_calls": [first, second]}])
    app = configured_app(tmp_path, provider)

    def unexpected_read(*args: Any, **kwargs: Any) -> None:
        pytest.fail("Malformed tool batch must be rejected before any reads")

    monkeypatch.setattr(WikiChat, "_execute", unexpected_read)
    with TestClient(app) as client:
        response = client.post(
            "/api/wiki/chat", json={"messages": [{"role": "user", "content": "Read it"}]}
        )
    assert response.status_code == 503
    assert response.json()["error"] == "chat_unavailable"
    assert len(provider.requests) == 1


def test_chat_returns_clean_reasoning_limit_error(tmp_path: Path) -> None:
    provider = ScriptedProvider(
        [
            {
                "content": None,
                "tool_calls": [call("search_wiki", '{"query":"missing"}', f"s{step}")],
            }
            for step in range(MAX_ROUNDS)
        ]
    )
    with TestClient(configured_app(tmp_path, provider)) as client:
        response = client.post(
            "/api/wiki/chat",
            json={"messages": [{"role": "user", "content": "Keep looking forever"}]},
        )

    assert response.status_code == 422
    assert response.json() == {
        "error": "chat_limit",
        "message": "The chat reached its reasoning-step limit.",
    }
    assert len(provider.requests) == MAX_ROUNDS


def test_chat_maps_provider_failure_to_clean_unavailable_error(tmp_path: Path) -> None:
    provider = ScriptedProvider([])

    async def unavailable(*args: Any, **kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("synthetic provider secret must not escape")

    provider.tool_chat = unavailable  # type: ignore[method-assign]
    with TestClient(configured_app(tmp_path, provider)) as client:
        response = client.post(
            "/api/wiki/chat",
            json={"messages": [{"role": "user", "content": "What is here?"}]},
        )

    assert response.status_code == 503
    assert response.json() == {
        "error": "chat_unavailable",
        "message": "The model provider is temporarily unavailable.",
    }


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
        return {"choices": [{"finish_reason": "tool_calls", "message": expected}]}

    monkeypatch.setattr(client, "_post_json_with_retry", response)
    result = await client.tool_chat(
        [{"role": "user", "content": "Find the harbor"}], WikiChat.tools()
    )
    assert result == expected
