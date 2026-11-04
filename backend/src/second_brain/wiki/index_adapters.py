"""Injected, opt-in managed indexes; Git snapshots remain authoritative."""

from __future__ import annotations

import logging
import math
import re
import tempfile
import time
from typing import Any, Protocol, TextIO
from uuid import NAMESPACE_URL, uuid5

from qdrant_client import QdrantClient, models

PAGE_EMBEDDING_MAX_CHARS = 2_000
CHUNK_OVERLAP_CHARS = 200
POINT_BATCH_SIZE = 64
logger = logging.getLogger(__name__)


def page_chunks(markdown: str) -> list[tuple[int, int, str]]:
    """Bound every provider input while covering the entire Unicode source.

    Offsets are Python Unicode code points, not bytes or browser UTF-16 units.
    Overlap keeps boundary context; even an empty page has one stable point.
    """
    chunks = []
    start = 0
    while True:
        end = min(len(markdown), start + PAGE_EMBEDDING_MAX_CHARS)
        chunks.append((start, end, markdown[start:end]))
        if end == len(markdown):
            return chunks
        start = end - CHUNK_OVERLAP_CHARS


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

        def read(tx: Any) -> list[str]:
            marker = tx.run(
                "MATCH (g:ManagedWikiGeneration {generation: $generation}) "
                "RETURN g.generation AS generation",
                generation=generation,
            ).single()
            if marker is None:
                raise RuntimeError("Managed graph generation is unavailable")
            result = tx.run(
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

        with self.driver.session(database=self.database) as session:
            return session.execute_read(read)  # type: ignore[no-any-return]

    def list_generations(self, namespace: str) -> list[str]:
        prefix = _generation(namespace) + "_"
        with self.driver.session(database=self.database) as session:
            result = session.run(
                "MATCH (g:ManagedWikiGeneration) "
                "WHERE g.generation STARTS WITH $prefix "
                "RETURN g.generation AS generation ORDER BY generation",
                prefix=prefix,
            )
            return [str(record["generation"]) for record in result]

    def delete_generation(self, generation: str) -> None:
        generation = _generation(generation)
        with self.driver.session(database=self.database) as session:
            session.execute_write(self._delete, generation)

    @staticmethod
    def _delete(tx: Any, generation: str) -> None:
        tx.run(
            "MATCH (p:ManagedWikiPage {generation: $generation}) DETACH DELETE p",
            generation=generation,
        ).consume()
        tx.run(
            "MATCH (g:ManagedWikiGeneration {generation: $generation}) DELETE g",
            generation=generation,
        ).consume()


class QdrantSnapshotAdapter:
    """A separate collection for each immutable managed generation."""

    def __init__(self, client: QdrantClient, embedder: Embedder, dimension: int | None) -> None:
        if dimension is not None and dimension < 1:
            raise ValueError("dimension must be positive")
        self.client = client
        self.embedder = embedder
        self.dimension = dimension

    @staticmethod
    def _collection(generation: str) -> str:
        return "managed_wiki_" + _generation(generation)

    def _vector(self, text: str, dimension: int | None) -> list[float]:
        vector = self.embedder.embed(text)
        if (
            not vector
            or (dimension is not None and len(vector) != dimension)
            or any(not math.isfinite(v) for v in vector)
        ):
            raise ValueError("Embedding has invalid dimension or nonfinite values")
        return vector

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        # Anonymous temporary storage bounds resident vector memory while
        # preserving validation-before-creation. No source text is spooled.
        with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as spool:
            self._build_spooled(generation, snapshot, spool)

    def _build_spooled(self, generation: str, snapshot: dict[str, Any], spool: TextIO) -> None:
        collection = self._collection(generation)
        dimension = self.dimension
        pages = _pages(snapshot)
        build_started = time.monotonic()
        for number, page in enumerate(pages, 1):
            chunks = page_chunks(page["markdown"])
            embedding_seconds = 0.0
            for index, (start, end, text) in enumerate(chunks):
                started = time.monotonic()
                try:
                    vector = self._vector(
                        text or page["title"][:PAGE_EMBEDDING_MAX_CHARS], dimension
                    )
                except Exception as exc:
                    # Never include source text, identifiers, credentials or raw
                    # provider messages. Class names distinguish failure kinds.
                    status = getattr(getattr(exc, "response", None), "status_code", None)
                    safe_status = (
                        status if isinstance(status, int) and 100 <= status <= 599 else None
                    )
                    logger.warning(
                        "Managed vector embedding failed page=%d/%d chunk=%d/%d "
                        "error_type=%s provider_status=%s embedding_seconds=%.3f "
                        "elapsed_seconds=%.3f",
                        number,
                        len(pages),
                        index + 1,
                        len(chunks),
                        type(exc).__name__,
                        safe_status,
                        time.monotonic() - started,
                        time.monotonic() - build_started,
                    )
                    raise
                embedding_seconds += time.monotonic() - started
                if dimension is None:
                    dimension = len(vector)
                point = models.PointStruct(
                    id=str(uuid5(NAMESPACE_URL, f"{page['id']}:{index}")),
                    vector=vector,
                    payload={
                        "id": page["id"],
                        "revision": page["revision"],
                        "snapshot_revision": snapshot["revision"],
                        "chunk": index,
                        "start": start,
                        "end": end,
                    },
                )
                spool.write(point.model_dump_json() + "\n")
            logger.info(
                "Managed vector embedding page=%d/%d chunks=%d embedding_seconds=%.3f "
                "elapsed_seconds=%.3f",
                number,
                len(pages),
                len(chunks),
                embedding_seconds,
                time.monotonic() - build_started,
            )
        if dimension is None:
            # An empty generation still needs the provider's actual output shape.
            dimension = len(self._vector("Managed wiki embedding dimension probe", None))
        # Creating an existing collection fails: never overwrite a completed generation.
        self.client.create_collection(
            collection_name=collection,
            vectors_config=models.VectorParams(size=dimension, distance=models.Distance.COSINE),
        )
        spool.seek(0)
        batch: list[models.PointStruct] = []
        for line in spool:
            batch.append(models.PointStruct.model_validate_json(line))
            if len(batch) == POINT_BATCH_SIZE:
                self.client.upsert(collection_name=collection, points=batch, wait=True)
                batch = []
        if batch:
            self.client.upsert(collection_name=collection, points=batch, wait=True)

    def search(self, generation: str, query: str, limit: int = 10) -> list[dict[str, Any]]:
        if not 1 <= limit <= 1000:
            raise ValueError("limit must be 1..1000")
        collection = self._collection(generation)
        dimension = self.dimension
        if dimension is None:
            vectors = self.client.get_collection(collection).config.params.vectors
            if not isinstance(vectors, models.VectorParams):
                raise ValueError("Managed collection must have one unnamed vector dimension")
            dimension = vectors.size
        result = self.client.query_points_groups(
            collection_name=collection,
            query=self._vector(query, dimension),
            limit=limit,
            group_by="id",
            group_size=1,
            with_payload=True,
        )
        return [
            {
                "id": (point.payload or {})["id"],
                "revision": (point.payload or {})["revision"],
                "score": point.score,
            }
            for group in result.groups
            for point in group.hits[:1]
        ]

    def list_generations(self, namespace: str) -> list[str]:
        prefix = self._collection(_generation(namespace) + "_")
        generations = []
        for collection in self.client.get_collections().collections:
            if collection.name.startswith(prefix):
                generation = collection.name.removeprefix("managed_wiki_")
                generations.append(_generation(generation))
        return sorted(generations)

    def delete_generation(self, generation: str) -> None:
        self.client.delete_collection(collection_name=self._collection(generation))
