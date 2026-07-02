"""
E2E integration test for the full ingestion flow.

Requires running Docker containers (via Testcontainers) and is
activated explicitly via the `integration_settings` fixture.
LLM calls and git operations are mocked; the edit_vault agent,
operation application, graph, and embeddings run for real.
"""
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from second_brain.worker.tasks import process_ingestion


def _docker_available() -> bool:
    try:
        import docker  # noqa: PLC0415
        docker.from_env().ping()
        return True
    except Exception:
        return False


class _FakeLLM:
    """chat_json returns a fixed create_page plan for any prompt."""

    def __init__(self, operations: list[dict[str, Any]]) -> None:
        self._operations = operations

    async def chat_json(self, _system: str, _user: str, **_kw: Any) -> dict[str, Any]:
        return {"operations": self._operations}

    async def complete(self, _system: str, _user: str, **_kw: Any) -> str:
        return ""


@pytest.mark.integration
@pytest.mark.skipif(not _docker_available(), reason="Docker not available")
def test_e2e_ingest_creates_wiki_page(integration_settings: object) -> None:
    """Full ingestion flow with mocked LLM: plan ops → apply → graph → embeddings."""
    vault_path = Path(str(getattr(integration_settings, "VAULT_PATH", "/tmp/vault")))
    wiki_dir = vault_path / "1_knowledge" / "wiki"
    wiki_dir.mkdir(parents=True, exist_ok=True)

    fake_embedder = type("E", (), {"embed": lambda self, _t: [0.1] * 1536})()
    fake_llm = _FakeLLM([
        {
            "op": "create_page",
            "title": "Testcontainers",
            "content": "Testcontainers is a tool for integration tests.",
        }
    ])
    fake_git = MagicMock()

    with (
        patch(
            "second_brain.worker.tasks.split_into_topics",
            new=AsyncMock(return_value=["Testcontainers makes integration tests easy."]),
        ),
        patch("second_brain.agent.edit_vault.get_llm_client", return_value=fake_llm),
        patch("second_brain.worker.tasks.sync_vault", return_value="no_changes"),
        patch("second_brain.worker.tasks.get_git_sync", return_value=fake_git),
        patch("second_brain.agent.edit_vault.get_embedder", return_value=fake_embedder),
        patch("second_brain.memory.indexing.get_embedder", return_value=fake_embedder),
    ):
        result = process_ingestion(
            "Testcontainers makes integration tests easy.", {}
        )

    assert result.startswith("ok:")

    wiki_files = list(wiki_dir.rglob("*.md"))
    assert len(wiki_files) >= 1
    content = (wiki_dir / "testcontainers.md").read_text(encoding="utf-8")
    assert "Testcontainers" in content
    assert "last_updated:" in content
    fake_git.push.assert_called_once()
    message = fake_git.push.call_args.args[0]
    assert message.startswith("remember:")
