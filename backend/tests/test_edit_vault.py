"""Unit tests for the edit_vault agent graph (LLM + infra mocked)."""
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from second_brain.core.config import settings


class _FakeLLM:
    def __init__(self, operations: list[dict[str, Any]]) -> None:
        self._operations = operations
        self.prompts: list[str] = []

    async def chat_json(self, _system: str, user: str, **_kw: Any) -> dict[str, Any]:
        self.prompts.append(user)
        return {"operations": self._operations}

    async def complete(self, _system: str, _user: str, **_kw: Any) -> str:
        return ""


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "VAULT_PATH", str(tmp_path / "vault"))
    wiki = tmp_path / "vault" / "1_knowledge" / "wiki"
    wiki.mkdir(parents=True)
    (wiki / "second-brain.md").write_text(
        "# Second Brain\n\nlast_updated: 2026-01-01\n\nA memory system.\n",
        encoding="utf-8",
    )
    return wiki


def _run(mode: str, focus: str, llm: _FakeLLM, hits: list[dict[str, Any]]) -> Any:
    from second_brain.agent.edit_vault import edit_vault
    from second_brain.worker.tasks import _run_async

    qdrant = MagicMock()
    qdrant.search.return_value = hits
    embedder = type("E", (), {"embed": lambda self, _t: [0.1] * 3})()
    git = MagicMock()

    with (
        patch("second_brain.agent.edit_vault.get_llm_client", return_value=llm),
        patch("second_brain.agent.edit_vault.get_embedder", return_value=embedder),
        patch("second_brain.agent.edit_vault.QdrantStore", return_value=qdrant),
        patch("second_brain.agent.edit_vault.get_git_sync", return_value=git),
        patch("second_brain.agent.edit_vault.update_graph_and_vectors") as mock_index,
    ):
        result = _run_async(edit_vault(mode, focus, source=focus[:120]))  # type: ignore[arg-type]
    return result, git, mock_index


def test_remember_updates_matched_page(vault: Path) -> None:
    llm = _FakeLLM([
        {"op": "add_claim", "page": "second-brain", "section": None,
         "text": "The repair loop runs hourly."}
    ])
    result, git, mock_index = _run(
        "remember", "The repair loop runs hourly.", llm, [{"slug": "second-brain"}]
    )

    assert result.result == "ok:1_pages"
    content = (vault / "second-brain.md").read_text(encoding="utf-8")
    assert "The repair loop runs hourly." in content
    # gather routed via retrieval: the matched page was shown to the planner
    assert "### Page: second-brain" in llm.prompts[0]
    mock_index.assert_called_once()
    git.push.assert_called_once()
    assert git.push.call_args.args[0].startswith("remember:")


def test_remember_creates_page_and_reconciles(vault: Path) -> None:
    llm = _FakeLLM([
        {"op": "create_page", "title": "Repair Loop",
         "content": "Hourly gardening job for the Second Brain wiki."}
    ])
    result, git, _ = _run("remember", "There is a repair loop.", llm, [])

    assert "repair-loop" in result.created
    new_page = (vault / "repair-loop.md").read_text(encoding="utf-8")
    assert new_page.startswith("# Repair Loop")
    # reconcile injected a wikilink for the mentioned existing page
    assert "[[second-brain|" in new_page
    git.push.assert_called_once()


def test_repair_rejects_create_page(vault: Path) -> None:
    llm = _FakeLLM([
        {"op": "create_page", "title": "Invented", "content": "Should not happen."}
    ])
    result, git, _ = _run("repair", "second-brain", llm, [{"slug": "second-brain"}])

    assert result.result == "no_changes"
    assert result.rejected
    assert not (vault / "invented.md").exists()
    git.push.assert_not_called()


def test_repair_empty_plan_is_valid(vault: Path) -> None:
    llm = _FakeLLM([])
    result, git, mock_index = _run("repair", "second-brain", llm, [{"slug": "second-brain"}])

    assert result.result == "no_changes"
    assert not result.changed
    mock_index.assert_not_called()
    git.push.assert_not_called()
