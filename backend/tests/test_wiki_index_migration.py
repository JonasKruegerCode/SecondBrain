"""Legacy ENV/dotenv activation with real local content and embedded Qdrant."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import Mock

import pytest
import qdrant_client

from second_brain.wiki.delivery_runtime import configured_delivery
from second_brain.wiki.index_config import _index_environment, configured_indexes
from second_brain.wiki.store import WikiStore


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.startswith(("SECOND_BRAIN_", "NEO4J_", "QDRANT_")):
            monkeypatch.delenv(name)
    launch = tmp_path / "launch"
    launch.mkdir()
    monkeypatch.chdir(launch)


def test_dotenv_precedence_matches_legacy_and_env_wins(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    Path(".env").write_text("QDRANT_URL=http://local.invalid\nSECOND_BRAIN_WIKI_VECTOR_INDEX=1\n")
    (tmp_path / ".env").write_text("QDRANT_URL=http://parent.invalid\n")
    assert _index_environment()["QDRANT_URL"] == "http://parent.invalid"
    monkeypatch.setenv("QDRANT_URL", "http://environment.invalid")
    assert _index_environment()["QDRANT_URL"] == "http://environment.invalid"


@pytest.mark.parametrize("kind", ["GRAPH", "VECTOR"])
def test_explicit_disable_overrides_inherited_endpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    endpoint = "NEO4J_URI" if kind == "GRAPH" else "QDRANT_URL"
    Path(".env").write_text(endpoint + "=http://must-not-connect.invalid\n")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_" + kind + "_INDEX", "0")
    indexes = configured_indexes(WikiStore(tmp_path / "vault"))
    assert indexes.adapters == {}
    indexes.close()


def test_settings_defaults_and_chat_key_do_not_enable_index_work(tmp_path: Path) -> None:
    Path(".env").write_text("OPENROUTER_API_KEY=synthetic-not-a-real-key\n")
    indexes = configured_indexes(WikiStore(tmp_path / "vault"))
    assert indexes.adapters == {}
    indexes.close()


def test_invalid_switch_is_not_silently_treated_as_disabled(tmp_path: Path) -> None:
    Path(".env").write_text("SECOND_BRAIN_WIKI_GRAPH_INDEX=typo\n")
    with pytest.raises(ValueError, match="must be empty, 0 or 1"):
        configured_indexes(WikiStore(tmp_path / "vault"))


def test_legacy_graph_dotenv_enables_provider_and_preserves_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import neo4j

    Path(".env").write_text(
        "NEO4J_URI=bolt://synthetic.invalid:7687\nNEO4J_USER=fixture\n"
        "NEO4J_PASSWORD=synthetic-password\nNEO4J_DATABASE=fixture-db\n"
    )
    driver = Mock()
    constructor = Mock(return_value=driver)
    monkeypatch.setattr(neo4j.GraphDatabase, "driver", constructor)
    indexes = configured_indexes(WikiStore(tmp_path / "vault"))
    try:
        assert set(indexes.adapters) == {"graph"}
        assert indexes.adapters["graph"].database == "fixture-db"
        constructor.assert_called_once_with(
            "bolt://synthetic.invalid:7687", auth=("fixture", "synthetic-password")
        )
    finally:
        indexes.close()
    driver.close.assert_called_once_with()


@pytest.mark.parametrize("source", ["env", "dotenv"])
def test_legacy_vector_start_rebuild_restart_and_provider_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, source: str
) -> None:
    from second_brain.core import config

    endpoint = "http://synthetic.invalid"
    if source == "dotenv":
        Path(".env").write_text("QDRANT_URL=" + endpoint + "\n")
    else:
        monkeypatch.setenv("QDRANT_URL", endpoint)
    monkeypatch.setattr(config, "settings", SimpleNamespace(
        LLM_PROVIDER="openrouter", EMBEDDING_MODEL="synthetic-seven",
        OPENROUTER_EMBEDDING_PROVIDER="",
    ))

    class Embeddings:
        fail = False

        def embed(self, text: str) -> list[float]:
            if self.fail:
                raise RuntimeError("synthetic provider unavailable")
            return [1.0] * 7

    embeddings = Embeddings()
    module = ModuleType("second_brain.llm.embedder")
    module.get_embedder = lambda: embeddings  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, module.__name__, module)
    actual_client = qdrant_client.QdrantClient

    def local_client(**kwargs: Any) -> qdrant_client.QdrantClient:
        assert kwargs["url"] == endpoint
        return actual_client(path=str(tmp_path / "qdrant"))

    monkeypatch.setattr(qdrant_client, "QdrantClient", local_client)
    remote, source_repo = tmp_path / "remote.git", tmp_path / "source"

    def git(path: Path, *args: str) -> str:
        return subprocess.check_output(
            ["git", "-C", str(path), *args], stderr=subprocess.PIPE
        ).decode()

    subprocess.run(["git", "init", "--bare", str(remote)], capture_output=True, check=True)
    subprocess.run(["git", "clone", str(remote), str(source_repo)], capture_output=True, check=True)
    git(source_repo, "checkout", "-b", "wiki")
    git(source_repo, "config", "user.email", "synthetic@localhost")
    git(source_repo, "config", "user.name", "Synthetic Fixture")
    page = source_repo / "1_knowledge/wiki/home.md"
    page.parent.mkdir(parents=True)
    page.write_text("# Synthetic home\n")
    git(source_repo, "add", ".")
    git(source_repo, "commit", "-m", "Synthetic source")
    git(source_repo, "push", "origin", "wiki")
    monkeypatch.setenv("VAULT_GIT_URL", str(remote))
    monkeypatch.setenv("VAULT_GIT_BRANCH", "wiki")
    store = WikiStore(tmp_path / "vault")
    indexes = configured_indexes(store)
    identity = indexes.config_id
    try:
        configured_delivery(store, indexes)
        saved = store.get_page("home")
        assert saved is not None
        assert indexes.adapters["vector"].dimension is None
        assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
        assert indexes.semantic_search("home")["results"][0]["id"] == "home"
    finally:
        indexes.close()
    indexes = configured_indexes(WikiStore(tmp_path / "vault"))
    try:
        assert indexes.config_id == identity
        assert indexes.semantic_search("home")["results"][0]["id"] == "home"
        store.save_page("home", "# Synthetic home\nChanged.\n", saved["revision"], "edit")
        embeddings.fail = True
        assert indexes.run_once()["indexes"]["vector"]["state"] == "error"
        assert "Changed." in store.get_page("home")["markdown"]  # type: ignore[index]
        embeddings.fail = False
        assert indexes.run_once()["indexes"]["vector"]["state"] == "current"
        assert indexes.semantic_search("home")["results"][0]["id"] == "home"
        delivery = configured_delivery(store, indexes)
        delivery.run_once()
        assert "Changed." in git(remote, "show", "wiki:1_knowledge/wiki/home.md")
        git(source_repo, "pull", "--ff-only", "origin", "wiki")
        page.write_text("# Synthetic home\nExternal edit.\n")
        git(source_repo, "add", ".")
        git(source_repo, "commit", "-m", "Synthetic external edit")
        git(source_repo, "push", "origin", "wiki")
        delivery.run_once()
        assert "External edit." in store.get_page("home")["markdown"]  # type: ignore[index]
        assert indexes.status()["indexes"]["vector"]["state"] == "current"
        assert indexes.semantic_search("home")["results"][0]["id"] == "home"
    finally:
        indexes.close()
