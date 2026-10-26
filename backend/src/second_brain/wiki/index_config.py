"""Explicit optional provider wiring; ordinary wiki startup needs no provider."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import ExitStack, suppress
from typing import Any

from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


def _close_after_failure(client: Any) -> None:
    # Cleanup must not replace the original configuration/startup exception.
    with suppress(Exception):
        client.close()


def configured_indexes(store: WikiStore) -> IndexCoordinator:
    with ExitStack() as cleanup:
        adapters: dict[str, Any] = {}
        # One bounded quoted SCRIPT attribute now shares flat-island exclusion.
        # Old ready receipts must rebuild even when Markdown is unchanged.
        identity: dict[str, Any] = {"schema": "managed-snapshots-v37"}
        if os.environ.get("SECOND_BRAIN_WIKI_GRAPH_INDEX") == "1":
            from neo4j import GraphDatabase  # noqa: PLC0415

            from second_brain.wiki.index_adapters import Neo4jSnapshotAdapter  # noqa: PLC0415

            uri = os.environ["NEO4J_URI"]
            user = os.environ["NEO4J_USER"]
            database = os.environ.get("NEO4J_DATABASE")
            driver = GraphDatabase.driver(uri, auth=(user, os.environ["NEO4J_PASSWORD"]))
            cleanup.callback(_close_after_failure, driver)
            adapters["graph"] = Neo4jSnapshotAdapter(driver, database=database)
            identity["graph"] = [uri, user, database]
        if os.environ.get("SECOND_BRAIN_WIKI_VECTOR_INDEX") == "1":
            from qdrant_client import QdrantClient  # noqa: PLC0415
            from second_brain.core.config import settings  # noqa: PLC0415
            from second_brain.llm.embedder import get_embedder  # noqa: PLC0415

            from second_brain.wiki.index_adapters import QdrantSnapshotAdapter  # noqa: PLC0415

            url = os.environ["QDRANT_URL"]
            dimension = int(os.environ["SECOND_BRAIN_WIKI_VECTOR_DIMENSION"])
            client = QdrantClient(url=url, api_key=os.environ.get("QDRANT_API_KEY"), timeout=60)
            cleanup.callback(_close_after_failure, client)
            adapters["vector"] = QdrantSnapshotAdapter(client, get_embedder(), dimension)
            identity["vector"] = [
                url,
                dimension,
                settings.LLM_PROVIDER,
                settings.EMBEDDING_MODEL,
                settings.GCP_ENDPOINT_URL
                if settings.LLM_PROVIDER == "gcp"
                else "https://openrouter.ai/api/v1",
                settings.OPENROUTER_EMBEDDING_PROVIDER
                if settings.LLM_PROVIDER == "openrouter"
                else "",
            ]
        config_id = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        indexes = IndexCoordinator(store, adapters, config_id=config_id)
        cleanup.pop_all()  # The complete coordinator now owns both clients.
        return indexes
