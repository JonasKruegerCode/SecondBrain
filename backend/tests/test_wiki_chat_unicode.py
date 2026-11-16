"""Reject non-scalar chat text before provider or wiki-tool dispatch."""

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from starlette.testclient import TestClient

from second_brain.core.config import settings
from second_brain.wiki.api import create_app
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


class Provider:
    def __init__(self, replies: list[dict[str, Any]]) -> None:
        self.replies = replies
        self.messages: list[list[dict[str, Any]]] = []

    async def tool_chat(
        self, messages: list[dict[str, Any]], *args: Any, **kwargs: Any
    ) -> dict[str, Any]:
        self.messages.append(messages.copy())
        return self.replies.pop(0)


def setup(tmp_path: Path, provider: Provider) -> tuple[Any, WikiChat]:
    store = WikiStore(tmp_path)
    indexes = IndexCoordinator(store)
    chat = WikiChat(store, indexes, provider)
    return create_app(tmp_path, indexes=indexes, chat=chat, close_indexes=True), chat


def tool() -> dict[str, Any]:
    return {
        "id": "read-1",
        "type": "function",
        "function": {"name": "read_page", "arguments": '{"page_id":"harbor"}'},
    }


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
@pytest.mark.parametrize("role", ["user", "assistant"])
def test_invalid_context_is_rejected_before_provider(
    tmp_path: Path, surrogate: str, role: str
) -> None:
    provider = Provider([{"content": "Synthetic answer."}])
    app, _ = setup(tmp_path, provider)
    messages = [{"role": role, "content": "Synthetic " + surrogate}]
    if role == "assistant":
        messages.append({"role": "user", "content": "Continue."})
    with TestClient(app) as client:
        response = client.post(
            "/api/wiki/chat",
            content=json.dumps({"messages": messages}),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 400
    assert response.json() == {"error": "invalid_payload", "message": "Provide valid Unicode text."}
    assert response.headers["cache-control"] == "no-store"
    assert provider.messages == []


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
@pytest.mark.parametrize("field", ["content", "id", "name", "arguments"])
def test_invalid_provider_batch_never_dispatches_tools(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, surrogate: str, field: str
) -> None:
    call = tool()
    valid = tool()
    valid["id"] = "read-0"
    reply: dict[str, Any] = {"content": "Synthetic batch", "tool_calls": [valid, call]}
    if field == "content":
        reply[field] += surrogate
    elif field == "id":
        call[field] += surrogate
    else:
        call["function"][field] += surrogate
    provider = Provider([reply, {"content": "Must not reach this answer."}])
    app, chat = setup(tmp_path, provider)
    dispatch = Mock(return_value={"error": "unexpected_dispatch"})
    monkeypatch.setattr(chat, "_execute", dispatch)
    with TestClient(app) as client:
        response = client.post(
            "/api/wiki/chat",
            json={"messages": [{"role": "user", "content": "Read the fictional harbor."}]},
        )
    assert response.status_code == 503
    assert response.json() == {
        "error": "chat_unavailable",
        "message": "The model returned invalid Unicode text.",
    }
    assert response.headers["cache-control"] == "no-store"
    dispatch.assert_not_called()
    assert len(provider.messages) == 1


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
def test_escaped_invalid_tool_query_returns_recoverable_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, surrogate: str
) -> None:
    call = tool()
    call["function"] = {"name": "search_wiki", "arguments": json.dumps({"query": surrogate})}
    provider = Provider([{"tool_calls": [call]}, {"content": "The query was invalid."}])
    app, chat = setup(tmp_path, provider)
    search = Mock(side_effect=AssertionError("Invalid text must not reach search"))
    monkeypatch.setattr(chat.store, "search", search)
    with TestClient(app) as client:
        response = client.post(
            "/api/wiki/chat",
            json={"messages": [{"role": "user", "content": "Search the fictional atlas."}]},
        )
    assert response.status_code == 200
    assert response.json()["answer"] == "The query was invalid."
    assert response.json()["sources"] == []
    assert response.json()["activity"] == []
    assert json.loads(provider.messages[-1][-1]["content"]) == {"error": "invalid_arguments"}
    search.assert_not_called()


def test_valid_unicode_remains_exact_in_context_tools_and_answer(tmp_path: Path) -> None:
    text = "Café / Cafe\u0301 / 海 / 😀 / مرحبا"
    call = tool()
    call["function"] = {"name": "search_wiki", "arguments": json.dumps({"query": text})}
    provider = Provider([{"tool_calls": [call]}, {"content": text}])
    app, chat = setup(tmp_path, provider)
    chat.store.save_page("harbor", "# Harbor\n" + text, None, "seed")
    with TestClient(app) as client:
        response = client.post(
            "/api/wiki/chat",
            content=json.dumps({"messages": [{"role": "user", "content": text}]}),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 200
    assert response.json()["answer"] == text
    assert provider.messages[0][-1]["content"] == text
    delivered = json.loads(provider.messages[-1][-1]["content"])
    assert delivered["results"][0]["id"] == "harbor"
    assert text in delivered["results"][0]["excerpt"]
    saved = chat.store.get_page("harbor")
    assert saved is not None and saved["markdown"] == "# Harbor\n" + text


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
def test_invalid_text_is_not_misclassified_as_missing_configuration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, surrogate: str
) -> None:
    monkeypatch.setattr(settings, "OPENROUTER_API_KEY", "")
    with TestClient(create_app(tmp_path, close_indexes=True)) as client:
        response = client.post(
            "/api/wiki/chat",
            content=json.dumps({"messages": [{"role": "user", "content": surrogate}]}),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_payload"


@pytest.mark.parametrize("role", [[], {}, None, 1])
def test_context_role_validation_stays_a_clean_client_error(tmp_path: Path, role: Any) -> None:
    with TestClient(
        create_app(tmp_path, close_indexes=True), raise_server_exceptions=False
    ) as client:
        response = client.post(
            "/api/wiki/chat", json={"messages": [{"role": role, "content": "Synthetic question."}]}
        )
    assert response.status_code == 400
    assert response.json()["error"] == "invalid_payload"
    assert response.headers["cache-control"] == "no-store"
