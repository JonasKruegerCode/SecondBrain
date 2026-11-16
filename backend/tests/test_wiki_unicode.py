"""Unicode scalar validation at the shared mutation boundary."""

import json
from pathlib import Path
from typing import Any
from unittest.mock import Mock

import pytest
from mcp.types import CallToolResult, TextContent
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.mcp import create_mcp
from second_brain.wiki.store import WikiError, WikiStore

ERROR = {"error": "invalid_payload", "message": "Provide valid Unicode text."}
CASES = [
    ("save_page", "markdown"),
    ("save_page", "base_revision"),
    ("save_page", "request_id"),
    ("delete_page", "base_revision"),
    ("delete_page", "request_id"),
]


@pytest.mark.parametrize(("operation", "field"), CASES)
@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
async def test_invalid_unicode_never_publishes(
    tmp_path: Path, operation: str, field: str, surrogate: str
) -> None:
    store = WikiStore(tmp_path)
    created = store.save_page("observatory", "# Observatory", None, "seed")
    args: dict[str, Any] = {
        "base_revision": created["revision"],
        "request_id": "retryable-request",
    }
    if operation == "save_page":
        args["markdown"] = "# Revised observatory"
    args[field] = "synthetic-" + surrogate
    head, history = store._head(), store.history("observatory")
    with pytest.raises(WikiError) as caught:
        getattr(store, operation)("observatory", **args)
    assert caught.value.code == ERROR["error"]
    assert caught.value.message == ERROR["message"]
    assert caught.value.details == {}

    # Direct FastMCP exercises domain conversion. Native SDK serializers/parsers
    # may reject unpaired surrogates before dispatching a tool call.
    mcp = create_mcp(store)
    result = await mcp.call_tool(operation, {"id": "observatory", **args})
    assert isinstance(result, CallToolResult) and result.isError
    assert result.structuredContent == ERROR
    assert isinstance(result.content[0], TextContent)
    assert json.loads(result.content[0].text) == ERROR

    # Raw escaped JSON reaches the REST parser without the client's UTF-8 encoder.
    with TestClient(create_app(tmp_path), raise_server_exceptions=False) as client:
        response = client.request(
            "DELETE" if operation == "delete_page" else "POST",
            "/api/wiki/pages/observatory",
            content=json.dumps(args, ensure_ascii=True),
            headers={"Content-Type": "application/json"},
        )
    assert response.status_code == 400
    assert response.json() == ERROR
    assert response.headers["cache-control"] == "no-store"
    assert store._head() == head
    assert store.history("observatory") == history
    # Rejected requests must not reserve their receipt or prevent a corrected retry.
    store.save_page("observatory", "# Corrected", created["revision"], "retryable-request")


def test_validation_precedes_head_access(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = WikiStore(tmp_path)
    head = Mock(side_effect=AssertionError("Invalid input must not read publication state"))
    monkeypatch.setattr(store, "_head", head)
    for field in ("markdown", "base_revision", "request_id"):
        args: dict[str, Any] = {"markdown": "# Valid", "base_revision": None, "request_id": "ok"}
        args[field] = "\ud800"
        with pytest.raises(WikiError, match="Provide valid Unicode text"):
            store.save_page("observatory", **args)
    head.assert_not_called()


def test_valid_unicode_preserves_bytes_and_receipts(tmp_path: Path) -> None:
    markdown = "# Observatoire 海\n\nCafé / Cafe\u0301 / 😀 / مرحبا\n"
    request_id = "créer-海-😀"
    store = WikiStore(tmp_path)
    with TestClient(create_app(tmp_path)) as client:
        args = {"markdown": markdown, "base_revision": None, "request_id": request_id}
        # ensure_ascii emits a valid surrogate pair for the astral character.
        response = client.post(
            "/api/wiki/pages/observatoire",
            content=json.dumps(args, ensure_ascii=True),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 200
    head = store._head()
    replay = store.save_page("observatoire", markdown, None, request_id)
    assert replay == response.json()
    assert store._head() == head
    assert store._blob(head, "pages/observatoire.md") == markdown.encode("utf-8")
    assert (store.get_page("observatoire") or {})["markdown"] == markdown
