"""Provider construction transfers ownership only after complete configuration."""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock

import pytest
import qdrant_client

from second_brain.wiki import index_config
from second_brain.wiki.store import WikiStore


@pytest.fixture
def providers(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    driver, client = Mock(), Mock()
    graph = ModuleType("neo4j")
    graph.GraphDatabase = SimpleNamespace(driver=Mock(return_value=driver))  # type: ignore[attr-defined]
    vector = qdrant_client
    monkeypatch.setattr(vector, "QdrantClient", Mock(return_value=client))
    config = ModuleType("second_brain.core.config")
    config.settings = SimpleNamespace(  # type: ignore[attr-defined]
        LLM_PROVIDER="openrouter", EMBEDDING_MODEL="synthetic", OPENROUTER_EMBEDDING_PROVIDER=""
    )
    embedder = ModuleType("second_brain.llm.embedder")
    embedder.get_embedder = Mock(return_value=object())  # type: ignore[attr-defined]
    for module in (graph, config, embedder):
        monkeypatch.setitem(sys.modules, module.__name__, module)
    for name, value in {
        "SECOND_BRAIN_WIKI_GRAPH_INDEX": "1",
        "SECOND_BRAIN_WIKI_VECTOR_INDEX": "1",
        "NEO4J_URI": "bolt://synthetic.invalid",
        "NEO4J_USER": "synthetic",
        "NEO4J_PASSWORD": "synthetic",
        "QDRANT_URL": "http://synthetic.invalid",
        "SECOND_BRAIN_WIKI_VECTOR_DIMENSION": "2",
    }.items():
        monkeypatch.setenv(name, value)
    return SimpleNamespace(driver=driver, client=client, vector=vector, embedder=embedder)


@pytest.mark.parametrize("fault", ["vector_config", "embedder", "adapter", "coordinator"])
def test_failed_configuration_closes_every_acquired_client(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, providers: SimpleNamespace, fault: str
) -> None:
    store = WikiStore(tmp_path / "vault")
    if fault == "vector_config":
        monkeypatch.delenv("QDRANT_URL")
        expected: type[Exception] = KeyError
    elif fault == "embedder":
        providers.embedder.get_embedder.side_effect = RuntimeError("synthetic embedding setup")
        expected = RuntimeError
    elif fault == "adapter":
        monkeypatch.setenv("SECOND_BRAIN_WIKI_VECTOR_DIMENSION", "0")
        expected = ValueError
    else:
        # A real local coordinator failure after both provider clients exist.
        (store.path / ".wiki-indexes.sqlite3").mkdir()
        expected = sqlite3.OperationalError
    with pytest.raises(expected):
        index_config.configured_indexes(store)
    providers.driver.close.assert_called_once_with()
    if fault == "vector_config":
        providers.vector.QdrantClient.assert_not_called()
        providers.client.close.assert_not_called()
    else:
        providers.client.close.assert_called_once_with()
    assert store.snapshot()["pages"] == []


def test_cleanup_failure_preserves_configuration_error_and_closes_other_clients(
    tmp_path: Path, providers: SimpleNamespace
) -> None:
    store = WikiStore(tmp_path / "vault")
    (store.path / ".wiki-indexes.sqlite3").mkdir()
    providers.client.close.side_effect = RuntimeError("synthetic close failure")
    with pytest.raises(sqlite3.OperationalError):
        index_config.configured_indexes(store)
    providers.driver.close.assert_called_once_with()
    providers.client.close.assert_called_once_with()


def test_successful_configuration_transfers_client_ownership(
    tmp_path: Path, providers: SimpleNamespace
) -> None:
    store = WikiStore(tmp_path / "vault")
    indexes = index_config.configured_indexes(store)
    providers.driver.close.assert_not_called()
    providers.client.close.assert_not_called()
    assert set(indexes.adapters) == {"graph", "vector"}
    indexes.close()
    providers.driver.close.assert_called_once_with()
    providers.client.close.assert_called_once_with()


def test_no_provider_startup_does_not_create_clients(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, providers: SimpleNamespace
) -> None:
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GRAPH_INDEX", "0")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_VECTOR_INDEX", "0")
    indexes = index_config.configured_indexes(WikiStore(tmp_path / "vault"))
    assert indexes.adapters == {}
    providers.vector.QdrantClient.assert_not_called()
    providers.driver.close.assert_not_called()
    indexes.close()
