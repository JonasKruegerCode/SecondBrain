
from typing import Any
from unittest.mock import patch

import pytest
from second_brain.memory.graph import Neo4jStore


@pytest.fixture
def mock_neo4j(monkeypatch: pytest.MonkeyPatch) -> None:
    class MockDriver:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        def close(self) -> None:
            pass

        def session(self) -> Any:
            class MockSession:
                def __enter__(self) -> Any:
                    return self
                def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
                    pass
                def run(self, query: str, parameters: Any = None, **kwargs: Any) -> Any:
                    class MockResult:
                        def __iter__(self) -> Any:
                            class MockRecord:
                                def data(self) -> dict[str, str]:
                                    return {"result": "success"}
                            yield MockRecord()
                    return MockResult()
            return MockSession()

    monkeypatch.setattr(
        "second_brain.memory.graph.GraphDatabase.driver", lambda *args, **kwargs: MockDriver()
    )


def test_neo4j_add_node(mock_neo4j: None) -> None:
    store = Neo4jStore("bolt://dummy", "user", "pass")
    store.add_node("Entity", {"id": "123", "name": "Test"})

    with pytest.raises(ValueError):
        store.add_node("Entity", {"name": "No ID"})

def test_neo4j_execute_query(mock_neo4j: None) -> None:
    store = Neo4jStore("bolt://dummy", "user", "pass")
    results = store.execute_query("MATCH (n) RETURN n")

    assert len(results) == 1
    assert results[0]["result"] == "success"


def test_direct_neighbors_include_relation_direction(mock_neo4j: None) -> None:
    store = Neo4jStore("bolt://dummy", "user", "pass")
    rows = [
        {
            "id": "graph",
            "title": "Knowledge Graph",
            "rel": "uses",
            "direction": "outgoing",
        }
    ]

    with patch.object(store, "execute_query", return_value=rows) as mock_query:
        result = store.get_neighbors_with_titles("second-brain", hops=1)

    assert result == rows
    query = mock_query.call_args.args[0]
    assert "r.rel AS rel" in query
    assert "startNode(r) = s" in query
