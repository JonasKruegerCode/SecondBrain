"""Unit-Tests für HybridRAG — LLM-Synthese wird gemockt."""
from typing import Any
from unittest.mock import AsyncMock, patch

from second_brain.memory.hybrid_rag import HybridRAG


class _FakeVectorStore:
    def search(self, _collection: str, _vec: list[float], limit: int = 5) -> list[dict[str, Any]]:
        return [{"slug": "topic-rust", "vault_path": "1_knowledge/wiki/topic-rust.md"}]

    def insert(self, _collection: str, _vec: list[float], _payload: dict[str, Any]) -> str:
        return "fake-id"


class _FakeGraphStore:
    def get_neighbors(self, _seeds: list[str], _hops: int = 2) -> list[str]:
        return ["person-jonas-krueger"]

    def add_node(self, _label: str, _props: dict[str, Any]) -> None:
        pass

    def add_edge(self, *args: Any, **kwargs: Any) -> None:
        pass

    def execute_query(self, _q: str, _params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        return []

    def close(self) -> None:
        pass


class _FakeVaultStore:
    def read_file(self, path: str) -> str | None:
        return f"# Inhalt von {path}\n\nTestinhalt."

    def write_file(self, _path: str, _content: str) -> None:
        pass

    def list_files(self, _prefix: str = "") -> list[str]:
        return []


class _FakeEmbedder:
    def embed(self, _text: str) -> list[float]:
        return [0.1] * 1536


async def test_hybrid_rag_returns_synthesized_context() -> None:
    rag = HybridRAG(_FakeVectorStore(), _FakeGraphStore(), _FakeVaultStore(), _FakeEmbedder())  # type: ignore[arg-type]

    with patch(
        "second_brain.memory.hybrid_rag.get_llm_client"
    ) as mock_fn:
        mock_client = AsyncMock()
        mock_fn.return_value = mock_client
        mock_client.complete = AsyncMock(return_value="Synthese: Jonas programmiert gerne Rust.")
        result = await rag.retrieve_context("Was mag Jonas?")

    assert "Synthese" in result or "Inhalt" in result


async def test_hybrid_rag_fallback_when_llm_fails() -> None:
    rag = HybridRAG(_FakeVectorStore(), _FakeGraphStore(), _FakeVaultStore(), _FakeEmbedder())  # type: ignore[arg-type]

    with patch(
        "second_brain.memory.hybrid_rag.get_llm_client"
    ) as mock_fn:
        mock_client = AsyncMock()
        mock_fn.return_value = mock_client
        mock_client.complete = AsyncMock(side_effect=Exception("API down"))
        result = await rag.retrieve_context("Testquery")

    assert "Testinhalt" in result or "nicht verfügbar" in result
