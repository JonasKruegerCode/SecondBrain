"""Legacy-compatible provider wiring; unconfigured wiki startup needs no provider."""

from __future__ import annotations

import hashlib
import json
import os
from contextlib import ExitStack, suppress
from typing import Any

from dotenv import dotenv_values

from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


def _close_after_failure(client: Any) -> None:
    # Cleanup must not replace the original configuration/startup exception.
    with suppress(Exception):
        client.close()


def _index_environment() -> dict[str, str]:
    """Use the legacy dotenv order and ENV precedence, without Settings defaults.

    Default localhost endpoints are not evidence of a configured installation.
    Only actual nonempty configuration may implicitly enable provider work.
    """
    configured: dict[str, str] = {}
    for path in (".env", "../.env"):
        configured.update({k.upper(): v for k, v in dotenv_values(path).items() if v is not None})
    configured.update({k.upper(): v for k, v in os.environ.items()})
    return configured


def _enabled(config: dict[str, str], flag: str, endpoint: str) -> bool:
    value = config.get(flag, "").strip()
    if value not in {"", "0", "1"}:
        raise ValueError(f"{flag} must be empty, 0 or 1.")
    return value == "1" or (not value and bool(config.get(endpoint, "").strip()))


def configured_indexes(store: WikiStore) -> IndexCoordinator:
    config = _index_environment()
    with ExitStack() as cleanup:
        adapters: dict[str, Any] = {}
        # One bounded quoted SCRIPT attribute now shares flat-island exclusion.
        # Old ready receipts must rebuild even when Markdown is unchanged.
        identity: dict[str, Any] = {"schema": "managed-snapshots-v37"}
        if _enabled(config, "SECOND_BRAIN_WIKI_GRAPH_INDEX", "NEO4J_URI"):
            from neo4j import GraphDatabase  # noqa: PLC0415

            from second_brain.wiki.index_adapters import Neo4jSnapshotAdapter  # noqa: PLC0415

            uri = config["NEO4J_URI"]
            user = config.get("NEO4J_USER", "neo4j")
            database = config.get("NEO4J_DATABASE") or None
            driver = GraphDatabase.driver(
                uri, auth=(user, config.get("NEO4J_PASSWORD", "secretpassword"))
            )
            cleanup.callback(_close_after_failure, driver)
            adapters["graph"] = Neo4jSnapshotAdapter(driver, database=database)
            identity["graph"] = [uri, user, database]
        if _enabled(config, "SECOND_BRAIN_WIKI_VECTOR_INDEX", "QDRANT_URL"):
            from qdrant_client import QdrantClient  # noqa: PLC0415

            from second_brain.core.config import settings  # noqa: PLC0415
            from second_brain.llm.embedder import get_embedder  # noqa: PLC0415
            from second_brain.wiki.index_adapters import QdrantSnapshotAdapter  # noqa: PLC0415

            url = config["QDRANT_URL"]
            supplied_dimension = config.get("SECOND_BRAIN_WIKI_VECTOR_DIMENSION", "").strip()
            dimension = int(supplied_dimension) if supplied_dimension else None
            client = QdrantClient(
                url=url, api_key=config.get("QDRANT_API_KEY") or None, timeout=60
            )
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
