"""
E2E integration test for the full ingestion flow.

Requires running Docker containers (via Testcontainers) and is
activated explicitly via the `integration_settings` fixture.
LLM calls (OpenRouter) and git operations are mocked.
"""
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from second_brain.llm.wiki_writer import WikiEditPlan
from second_brain.worker.tasks import process_ingestion


def _docker_available() -> bool:
    try:
        import docker  # noqa: PLC0415
        docker.from_env().ping()
        return True
    except Exception:
        return False


@pytest.mark.integration
@pytest.mark.skipif(not _docker_available(), reason="Docker not available")
def test_e2e_ingest_creates_wiki_page(integration_settings: object) -> None:
    """Full ingestion flow with mocked LLM: planning → wiki page write → graph → embeddings."""
    vault_path = Path(str(getattr(integration_settings, "VAULT_PATH", "/tmp/vault")))
    wiki_dir = vault_path / "1_knowledge" / "wiki"
    wiki_dir.mkdir(parents=True, exist_ok=True)

    fake_embedder = type("E", (), {"embed": lambda self, _t: [0.1] * 1536})()
    fake_plan = WikiEditPlan(new_pages=[{"title": "Testcontainers"}])
    fake_page = (
        "# Testcontainers\n\nlast_updated: 2026-05-08\n\n"
        "Testcontainers is a tool for integration tests.\n"
    )

    with (
        patch(
            "second_brain.worker.tasks.split_into_topics",
            new=AsyncMock(return_value=["Testcontainers makes integration tests easy."]),
        ),
        patch(
            "second_brain.worker.tasks.plan_wiki_edits",
            new=AsyncMock(return_value=fake_plan),
        ),
        patch(
            "second_brain.worker.tasks.update_wiki_page",
            new=AsyncMock(return_value=fake_page),
        ),
        patch("second_brain.worker.tasks.get_git_sync") as mock_git,
        patch("second_brain.worker.tasks.get_embedder", return_value=fake_embedder),
    ):
        mock_git.return_value.push = lambda msg: None

        result = process_ingestion(
            "Testcontainers makes integration tests easy.", {}
        )

    assert result.startswith("ok:")

    wiki_files = list(wiki_dir.rglob("*.md"))
    assert len(wiki_files) >= 1
    content = wiki_files[0].read_text(encoding="utf-8")
    assert "Testcontainers" in content
