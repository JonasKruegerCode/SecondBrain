"""Synthetic long-page continuation through real wiki/chat services."""

import json
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.chat import MAX_TOOL_RESULT_CHARS, WikiChat, _bounded_tool_json
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


class TailProvider:
    """Deterministic tool protocol fixture, not a real model-quality check."""

    def __init__(self) -> None:
        self.chunks: list[dict[str, Any]] = []
        self.requests = 0

    async def tool_chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        model: str | None = None,
        max_tokens: int = 1200,
    ) -> dict[str, Any]:
        self.requests += 1
        if messages[-1]["role"] == "tool":
            assert len(messages[-1]["content"]) <= MAX_TOOL_RESULT_CHARS
            chunk = json.loads(messages[-1]["content"])
            self.chunks.append(chunk)
            if chunk["next_offset"] is None:
                assert "The synthetic beacon is amber." in "".join(
                    x["markdown"] for x in self.chunks
                )
                return {"content": "The synthetic beacon is amber."}
            args = {
                "page_id": "archive",
                "offset": chunk["next_offset"],
                "expected_revision": chunk["revision"],
            }
        else:
            args = {"page_id": "archive"}
        return {
            "tool_calls": [
                {
                    "id": f"read-{self.requests}",
                    "type": "function",
                    "function": {"name": "read_page", "arguments": json.dumps(args)},
                }
            ]
        }


def chat_with_page(tmp_path: Path, markdown: str) -> tuple[WikiChat, str]:
    store = WikiStore(tmp_path)
    page = store.save_page("archive", markdown, base_revision=None, request_id="seed-long-page")
    return WikiChat(store, IndexCoordinator(store), TailProvider()), page["revision"]


@pytest.mark.parametrize(
    "body", ["Plain text.\n" * 1_000, '\\"🛰漢字\n' * 1_700], ids=["plain", "escaped-unicode"]
)
def test_continuation_reassembles_exact_unicode_and_escaped_bytes(
    tmp_path: Path, body: str
) -> None:
    markdown = "# Archive\n" + body + "\nThe synthetic beacon is amber.\n"
    chat, revision = chat_with_page(tmp_path, markdown)
    pieces: list[str] = []
    offset = 0
    for _ in range(20):
        args: dict[str, Any] = {"page_id": "archive", "offset": offset}
        if offset:
            args["expected_revision"] = revision
        result = chat._read(args, {}, [])
        encoded = _bounded_tool_json(result)
        assert len(encoded) <= MAX_TOOL_RESULT_CHARS
        chunk = json.loads(encoded)
        assert chunk["offset"] == offset and chunk["total_chars"] == len(markdown)
        assert chunk["revision"] == revision
        pieces.append(chunk["markdown"])
        if chunk["next_offset"] is None:
            assert chunk["truncated"] is False
            break
        assert chunk["truncated"] is True
        assert chunk["next_offset"] == offset + len(chunk["markdown"]) > offset
        offset = chunk["next_offset"]
    else:
        pytest.fail("Continuation did not finish")
    assert "".join(pieces).encode() == markdown.encode()


def test_real_chat_endpoint_reaches_evidence_after_initial_chunk(tmp_path: Path) -> None:
    markdown = "# Archive\n" + "Synthetic background.\n" * 600 + "The synthetic beacon is amber."
    chat, _ = chat_with_page(tmp_path, markdown)
    with TestClient(create_app(tmp_path, indexes=chat.indexes, chat=chat)) as client:
        response = client.post(
            "/api/wiki/chat",
            json={"messages": [{"role": "user", "content": "What color is the beacon?"}]},
        )
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    result = response.json()
    assert result["answer"] == "The synthetic beacon is amber."
    assert result["limits"]["tool_calls"] == 2
    assert result["sources"] == [{"id": "archive", "title": "Archive", "evidence": "read"}]


@pytest.mark.parametrize("offset", [-1, True, 1.5, "1", None, 100_000])
def test_invalid_offsets_are_rejected(tmp_path: Path, offset: Any) -> None:
    chat, revision = chat_with_page(tmp_path, "# Archive\nEvidence.")
    assert (
        chat._read({"page_id": "archive", "offset": offset, "expected_revision": revision}, {}, [])[
            "error"
        ]
        == "invalid_arguments"
    )


def test_continuation_requires_current_revision_and_never_changes_content(tmp_path: Path) -> None:
    markdown = "# Archive\n" + "original " * 2_000
    chat, revision = chat_with_page(tmp_path, markdown)
    assert chat._read({"page_id": "archive", "offset": 2}, {}, [])["error"] == "invalid_arguments"
    changed = chat.store.save_page(
        "archive",
        "# Archive\nNew revision.",
        base_revision=revision,
        request_id="change-between-reads",
    )
    result = chat._read({"page_id": "archive", "offset": 2, "expected_revision": revision}, {}, [])
    assert result["error"] == "revision_conflict"
    current = chat.store.get_page("archive")
    assert current is not None
    assert current["revision"] == changed["revision"]
    assert current["markdown"] == changed["markdown"]
    latest = chat._read({"page_id": "archive"}, {}, [])
    assert latest["revision"] == changed["revision"]
    assert latest["markdown"] == "# Archive\nNew revision."


def test_exact_end_is_empty_without_false_read_evidence(tmp_path: Path) -> None:
    markdown = "# Archive\nEvidence."
    chat, revision = chat_with_page(tmp_path, markdown)
    result = chat._read(
        {"page_id": "archive", "offset": len(markdown), "expected_revision": revision}, {}, []
    )
    assert result["markdown"] == "" and result["next_offset"] is None
    assert result["truncated"] is False


@pytest.mark.parametrize("title_length", [7800, 7801])
def test_metadata_budget_never_returns_an_oversized_or_stalled_chunk(title_length: int) -> None:
    result = {
        "id": "a",
        "title": "x" * title_length,
        "revision": "a" * 64,
        "markdown": "x" * 100,
        "offset": 10000,
        "total_chars": 10100,
        "next_offset": None,
        "truncated": False,
    }
    encoded = _bounded_tool_json(result)
    assert len(encoded) <= MAX_TOOL_RESULT_CHARS
    assert json.loads(encoded)["error"] == "tool_result_too_large"


@pytest.mark.parametrize(
    "revision",
    [None, False, 3, "", "x" * 161],
    ids=["null", "boolean", "number", "empty", "too-long"],
)
def test_invalid_expected_revision_types_are_rejected(tmp_path: Path, revision: Any) -> None:
    chat, _ = chat_with_page(tmp_path, "# Archive\nEvidence.")
    assert (
        chat._read({"page_id": "archive", "expected_revision": revision}, {}, [])["error"]
        == "invalid_arguments"
    )


def test_read_tool_schema_advertises_bounded_continuation() -> None:
    tool = next(
        item["function"] for item in WikiChat.tools() if item["function"]["name"] == "read_page"
    )
    params = tool["parameters"]
    assert params["additionalProperties"] is False
    assert params["required"] == ["page_id"]
    assert params["properties"]["offset"] == {"type": "integer", "minimum": 0}
    assert "next_offset" in tool["description"] and "expected_revision" in tool["description"]
