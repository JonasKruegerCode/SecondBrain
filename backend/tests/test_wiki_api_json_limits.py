"""Reject parser-depth failures before dispatching managed requests."""

from pathlib import Path

import pytest
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize("method,path", [
    ("POST", "/api/wiki/pages/synthetic"),
    ("DELETE", "/api/wiki/pages/synthetic"),
    ("POST", "/api/wiki/chat"),
])
def test_deep_json_is_rejected_before_content_or_chat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, method: str, path: str,
) -> None:
    app = create_app(tmp_path, "synthetic-key")
    store = app.state.wiki_store
    store.save_page("synthetic", "# Synthetic\nAn invented observation.", None, "seed")
    before = store.snapshot()
    history = store.history("synthetic")

    def unexpected(*args: object, **kwargs: object) -> None:
        pytest.fail("Invalid JSON reached a content or chat service.")

    monkeypatch.setattr(WikiStore, "save_page", unexpected)
    monkeypatch.setattr(WikiStore, "delete_page", unexpected)
    monkeypatch.setattr(WikiChat, "validate_messages", unexpected)
    # Each payload is below both HTTP byte limits, but exceeds CPython's
    # decoder recursion budget. It must not become an unhandled 500 response.
    body = "[" * 11_000 + "0" + "]" * 11_000
    assert len(body.encode()) < 25_000
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.request(method, path, content=body, headers={
            "Authorization": "Bearer synthetic-key", "Content-Type": "application/json",
        })
        assert response.status_code == 400
        assert response.json()["error"] == "invalid_payload"
        assert response.headers["cache-control"] == "no-store"
        assert client.get("/api/wiki/health", headers={
            "Authorization": "Bearer synthetic-key",
        }).status_code == 200
    assert store.snapshot() == before
    assert store.history("synthetic") == history
