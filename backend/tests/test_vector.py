from typing import Any

import pytest
from qdrant_client.models import VectorParams

from second_brain.memory.vector import QdrantStore


@pytest.fixture
def mock_qdrant(monkeypatch: pytest.MonkeyPatch) -> None:
    # Basic mock for QdrantClient to avoid needing a real instance for unit tests
    # In a real scenario, consider using Testcontainers for integration tests

    class MockClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.collections: set[str] = set()
            self.data: dict[str, list[Any]] = {}

        def collection_exists(self, collection_name: str) -> bool:
            return collection_name in self.collections

        def create_collection(self, collection_name: str, vectors_config: VectorParams) -> None:
            self.collections.add(collection_name)
            self.data[collection_name] = []

        def upsert(self, collection_name: str, points: list[Any]) -> None:
            self.data[collection_name].extend(points)

        def query_points(self, collection_name: str, query: list[float], limit: int) -> Any:
            class MockHit:
                def __init__(self, payload: Any) -> None:
                    self.payload = payload

            class MockResponse:
                def __init__(self, points: list[Any]) -> None:
                    self.points = points

            # Just return dummy matches
            return MockResponse(points=[MockHit(payload={"text": "dummy"})])

    monkeypatch.setattr("second_brain.memory.vector.QdrantClient", MockClient)


def test_qdrant_insert_and_search(mock_qdrant: None) -> None:
    store = QdrantStore(url="http://dummy")

    # Test insert
    vector = [0.1, 0.2, 0.3]
    payload = {"text": "hello world"}
    point_id = store.insert("test_col", vector, payload)

    assert isinstance(point_id, str)

    # Test search
    results = store.search("test_col", query_vector=[0.1, 0.2, 0.3], limit=1)

    assert len(results) == 1
    assert results[0]["text"] == "dummy"
