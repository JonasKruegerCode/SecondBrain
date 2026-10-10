"""Injected, opt-in managed indexes; Git snapshots remain authoritative."""

from __future__ import annotations

import math
import re
from typing import Any, Protocol
from uuid import NAMESPACE_URL, uuid5

from qdrant_client import QdrantClient, models


class Embedder(Protocol):
    def embed(self, text: str) -> list[float]: ...


def _generation(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_]{1,200}", value):
        raise ValueError("Invalid managed generation")
    return value


def _pages(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = snapshot["pages"]
    if len({page["id"] for page in pages}) != len(pages):
        raise ValueError("Duplicate page IDs")
    return pages


class Neo4jSnapshotAdapter:
    """Full generations isolated from the legacy WikiPage label."""

    def __init__(self, driver: Any, database: str | None = None) -> None:
        self.driver = driver
        self.database = database

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        generation = _generation(generation)
        pages = _pages(snapshot)
        ids = {page["id"] for page in pages}
        edges = snapshot["graph"]["edges"]
        if any(edge["source"] not in ids or edge["target"] not in ids for edge in edges):
            raise ValueError("Graph edge references a missing page")
        with self.driver.session(database=self.database) as session:
            session.run(
                "CREATE CONSTRAINT managed_wiki_generation_unique IF NOT EXISTS "
                "FOR (g:ManagedWikiGeneration) REQUIRE g.generation IS UNIQUE"
            ).consume()
            session.execute_write(self._write, generation, snapshot["revision"], pages, edges)

    @staticmethod
    def _write(
        tx: Any,
        generation: str,
        revision: str,
        pages: list[dict[str, Any]],
        edges: list[dict[str, Any]],
    ) -> None:
        # CREATE plus the unique constraint rejects reuse, even for an empty generation.
        tx.run(
            "CREATE (:ManagedWikiGeneration {generation: $generation, revision: $revision})",
            generation=generation,
            revision=revision,
        ).consume()
        tx.run(
            "UNWIND $pages AS page CREATE (:ManagedWikiPage "
            "{generation: $generation, id: page.id, revision: page.revision, title: page.title})",
            generation=generation,
            pages=pages,
        ).consume()
        tx.run(
            "UNWIND $edges AS edge "
            "MATCH (a:ManagedWikiPage {generation: $generation, id: edge.source}) "
            "MATCH (b:ManagedWikiPage {generation: $generation, id: edge.target}) "
            "CREATE (a)-[:LINKS_TO {rel: coalesce(edge.rel, edge.type, 'wikilink')}]->(b)",
            generation=generation,
            edges=edges,
        ).consume()

    def neighbors(
        self,
        generation: str,
        seeds: list[str],
        hops: int = 1,
        limit: int = 50,
    ) -> list[str]:
        generation = _generation(generation)
        if not 1 <= hops <= 3 or not 1 <= limit <= 1000:
            raise ValueError("hops must be 1..3 and limit 1..1000")
        with self.driver.session(database=self.database) as session:
            result = session.run(
                "MATCH (a:ManagedWikiPage {generation: $generation}) "
                "WHERE a.id IN $seeds "
                f"MATCH path=(a)-[:LINKS_TO*1..{hops}]-(b:ManagedWikiPage) "
                "WHERE all(n IN nodes(path) WHERE n.generation = $generation) "
                "AND NOT b.id IN $seeds RETURN DISTINCT b.id AS id ORDER BY id LIMIT $limit",
                generation=generation,
                seeds=seeds,
                limit=limit,
            )
            return [str(record["id"]) for record in result]


class QdrantSnapshotAdapter:
    """A separate collection for each immutable managed generation."""

    def __init__(self, client: QdrantClient, embedder: Embedder, dimension: int) -> None:
        if dimension < 1:
            raise ValueError("dimension must be positive")
        self.client = client
        self.embedder = embedder
        self.dimension = dimension

    @staticmethod
    def _collection(generation: str) -> str:
        return "managed_wiki_" + _generation(generation)

    def _vector(self, text: str) -> list[float]:
        vector = self.embedder.embed(text)
        if len(vector) != self.dimension or any(not math.isfinite(v) for v in vector):
            raise ValueError("Embedding has invalid dimension or nonfinite values")
        return vector

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        collection = self._collection(generation)
        points = [
            models.PointStruct(
                id=str(uuid5(NAMESPACE_URL, page["id"])),
                vector=self._vector(page["markdown"]),
                payload={
                    "id": page["id"],
                    "revision": page["revision"],
                    "snapshot_revision": snapshot["revision"],
                },
            )
            for page in _pages(snapshot)
        ]
        # Creating an existing collection fails: never overwrite a completed generation.
        self.client.create_collection(
            collection_name=collection,
            vectors_config=models.VectorParams(
                size=self.dimension, distance=models.Distance.COSINE
            ),
        )
        if points:
            self.client.upsert(collection_name=collection, points=points, wait=True)

    def search(self, generation: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
        if not 1 <= limit <= 1000:
            raise ValueError("limit must be 1..1000")
        result = self.client.query_points(
            collection_name=self._collection(generation),
            query=self._vector(query),
            limit=limit,
            with_payload=True,
        )
        return [
            {
                "id": (point.payload or {})["id"],
                "revision": (point.payload or {})["revision"],
                "score": point.score,
            }
            for point in result.points
        ]
