"""Shared wiki search for REST, MCP and tests.

Default behaviour mirrors MCP ``search_wiki`` with omitted ``mode``: hybrid
semantic ranking when the vector index is ready, otherwise ranked lexical Markdown.
"""

from __future__ import annotations

from typing import Any

from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.relevance import trim_ranked
from second_brain.wiki.store import SEARCH_RESULT_LIMIT, WikiError, WikiStore

_SEARCH_HIT_KEYS = frozenset({"markdown", "rank_score"})


def _public_hits(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: v for k, v in row.items() if k not in _SEARCH_HIT_KEYS} for row in rows]


def search_wiki(
    store: WikiStore,
    indexes: IndexCoordinator,
    query: str,
    *,
    mode: str | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Ranked search with optional explicit mode and limit.

    ``limit=None`` applies the adaptive relevance cutoff (MCP/website default).
    An explicit ``limit`` disables cutoff and caps the ranked list, like MCP.
    """
    implicit = mode is None
    selected = (
        mode
        if mode is not None
        else ("semantic" if "vector" in indexes.adapters else "lexical")
    )
    if selected not in {"lexical", "semantic", "graph_rag"}:
        raise WikiError("invalid_payload", "mode must be lexical, semantic or graph_rag.")
    if limit is not None and not 1 <= limit <= SEARCH_RESULT_LIMIT:
        raise WikiError("invalid_payload", "limit must be between 1 and 50.")
    if not query.strip():
        if selected == "graph_rag":
            return {"mode": "graph_rag", "results": [], "hops": 1}
        if selected == "semantic":
            snapshot = store.snapshot()
            return {
                "mode": "semantic",
                "revision": snapshot["revision"],
                "results": [],
            }
        maximum = limit or SEARCH_RESULT_LIMIT
        return {
            "mode": "lexical",
            "results": [],
            "limit": maximum,
            "truncated": False,
        }
    if selected == "semantic":
        try:
            if implicit and limit is None:
                return indexes.semantic_search(query, None)
            return indexes.semantic_search(query, 10 if limit is None else limit)
        except WikiError as exc:
            # While vectors rebuild, default searches stay useful via lexical ranking.
            if not (implicit and exc.code == "index_pending"):
                raise
            selected = "lexical"
    if selected == "graph_rag":
        result = indexes.graph_search(query)
        if limit is not None:
            result["results"] = result["results"][:limit]
        return result
    maximum = limit or SEARCH_RESULT_LIMIT
    rows = store.search(query, limit=maximum + 1)
    visible, truncated, cutoff = trim_ranked(rows, maximum, enabled=limit is None)
    payload: dict[str, Any] = {
        "mode": "lexical",
        "results": _public_hits(visible),
        "limit": maximum,
        "truncated": truncated,
    }
    if cutoff:
        payload["cutoff"] = True
    return payload
