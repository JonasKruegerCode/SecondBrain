"""Unit tests for MCP tool dispatch logic (no Docker required)."""
from unittest.mock import MagicMock, patch

import pytest

from second_brain.mcp_server import _dispatch


@pytest.mark.asyncio
async def test_remember_dispatches_celery() -> None:
    mock_task = MagicMock()
    mock_task.id = "test-task-id"
    with patch(
        "second_brain.mcp_server.process_ingestion"
    ) as mock_proc:
        mock_proc.delay.return_value = mock_task
        result = await _dispatch("remember", {"text": "Jonas mag Rust"})

    assert "test-task-id" in result
    mock_proc.delay.assert_called_once_with("Jonas mag Rust", {})


@pytest.mark.asyncio
async def test_search_wiki_dispatches_vector_search() -> None:
    search_result: list[dict[str, object]] = [
        {"id": "rust", "title": "Rust", "neighbors": [{"id": "cargo", "title": "Cargo"}]},
    ]

    async def _async_search(*_args: object, **_kwargs: object) -> list[dict[str, object]]:
        return search_result

    mock_rag = MagicMock()
    mock_rag.search = _async_search
    mock_graph_store = MagicMock()

    with (
        patch(
            "second_brain.mcp_server._build_rag",
            return_value=(mock_rag, mock_graph_store),
        ),
        patch("second_brain.mcp_server.sync_vault", return_value="no_changes"),
    ):
        result = await _dispatch("search_wiki", {"query": "Rust", "limit": 15, "hpos": 1})

    assert "Rust" in result
    assert "Cargo" in result
    assert "rust" in result
    mock_graph_store.close.assert_called_once()


@pytest.mark.asyncio
async def test_get_page_dispatches_vault_ops() -> None:
    with (
        patch("second_brain.mcp_server.vault_ops") as mock_vault_ops,
        patch("second_brain.mcp_server.sync_vault", return_value="no_changes") as mock_sync,
    ):
        mock_vault_ops.get_page.return_value = "# Rust\n..."
        result = await _dispatch("get_page", {"id": "rust"})

    assert result == "# Rust\n..."
    mock_vault_ops.get_page.assert_called_once_with("rust")
    mock_sync.assert_called_once()  # reads sync before serving


@pytest.mark.asyncio
async def test_unknown_tool() -> None:
    result = await _dispatch("nonexistent_tool", {})
    assert "Unknown tool" in result


def test_stale_running_logs_are_marked_failed() -> None:
    from second_brain.mcp_server import _mark_stale_running

    fresh = {"status": "running", "started": "2999-01-01T00:00:00"}
    _mark_stale_running(fresh)
    assert fresh["status"] == "running"

    stale = {"status": "running", "started": "2020-01-01T00:00:00"}
    _mark_stale_running(stale)
    assert stale["status"] == "failed"
    assert "stale" in str(stale["error"])

    done = {"status": "done", "started": "2020-01-01T00:00:00"}
    _mark_stale_running(done)
    assert done["status"] == "done"
