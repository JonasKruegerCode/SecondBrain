import uuid
from typing import Any, Protocol

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

from second_brain.core.telemetry import get_tracer

tracer = get_tracer(__name__)


class VectorStore(Protocol):
    """
    Protocol defining the interface for vector database operations.
    """

    def insert(self, collection_name: str, vector: list[float], payload: dict[str, Any]) -> str:
        """Insert a vector and its metadata. Returns the generated ID."""
        ...

    def search(
        self, collection_name: str, query_vector: list[float], limit: int = 5
    ) -> list[dict[str, Any]]:
        """Search for similar vectors. Returns a list of payloads."""
        ...


class QdrantStore:
    """
    Qdrant implementation of the VectorStore.
    """

    def __init__(self, url: str) -> None:
        self.client = QdrantClient(url=url, check_compatibility=False)

    def _ensure_collection(self, collection_name: str, vector_size: int = 1536) -> None:
        """Ensure the collection exists."""
        if not self.client.collection_exists(collection_name=collection_name):
            self.client.create_collection(
                collection_name=collection_name,
                vectors_config=VectorParams(size=vector_size, distance=Distance.COSINE),
            )

    def insert(self, collection_name: str, vector: list[float], payload: dict[str, Any]) -> str:
        """Insert a vector into Qdrant."""
        with tracer.start_as_current_span("qdrant.insert") as span:
            span.set_attribute("db.qdrant.collection", collection_name)
            self._ensure_collection(collection_name, len(vector))
            point_id = str(uuid.uuid4())
            self.client.upsert(
                collection_name=collection_name,
                points=[
                    PointStruct(
                        id=point_id,
                        vector=vector,
                        payload=payload,
                    )
                ],
            )
            return point_id

    def upsert(
        self,
        collection_name: str,
        vector: list[float],
        payload: dict[str, Any],
        point_id: str | None = None,
    ) -> str:
        """Upsert a vector with a stable (deterministic) ID."""
        with tracer.start_as_current_span("qdrant.upsert") as span:
            span.set_attribute("db.qdrant.collection", collection_name)
            self._ensure_collection(collection_name, len(vector))
            pid = point_id or str(uuid.uuid4())
            self.client.upsert(
                collection_name=collection_name,
                points=[PointStruct(id=pid, vector=vector, payload=payload)],
            )
            return pid

    def search(
        self, collection_name: str, query_vector: list[float], limit: int = 5
    ) -> list[dict[str, Any]]:
        """Search in Qdrant and return payloads."""
        with tracer.start_as_current_span("qdrant.search") as span:
            span.set_attribute("db.qdrant.collection", collection_name)
            span.set_attribute("db.qdrant.limit", limit)
            self._ensure_collection(collection_name, len(query_vector))
            search_result = self.client.query_points(
                collection_name=collection_name, query=query_vector, limit=limit
            )
            results = [hit.payload for hit in search_result.points if hit.payload is not None]
            span.set_attribute("db.qdrant.hits", len(results))
            return results

    def delete(self, collection_name: str, point_id: str) -> None:
        """Delete a point by ID."""
        with tracer.start_as_current_span("qdrant.delete") as span:
            span.set_attribute("db.qdrant.collection", collection_name)
            self.client.delete(collection_name=collection_name, points_selector=[point_id])
