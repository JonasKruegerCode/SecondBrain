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
async def test_unknown_tool() -> None:
    result = await _dispatch("nonexistent_tool", {})
    assert "Unknown tool" in result
