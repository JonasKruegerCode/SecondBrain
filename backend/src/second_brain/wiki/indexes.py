"""Recoverable snapshot indexing; Git remains the only content authority.

The worker lock serializes builders, not content writers. Every attempt has a
fresh isolated generation, so a failed/late build cannot corrupt a live index.
Only a durable receipt makes that generation readable, and only at its exact
content revision. Missing receipts are reconstructed by comparing the Git head.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import sqlite3
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any, Protocol

from second_brain.wiki.store import WikiError, WikiStore


class SnapshotIndex(Protocol):
    def build(self, generation: str, snapshot: dict[str, Any]) -> None: ...


class IndexCoordinator:
    def __init__(
        self, store: WikiStore, adapters: dict[str, Any] | None = None, *, config_id: str = "v1"
    ) -> None:
        self.store = store
        self.adapters = adapters or {}
        if set(self.adapters) - {"graph", "vector"}:
            raise ValueError("Supported indexes: graph and vector.")
        self.config_id = config_id
        self.db_path = store.path / ".wiki-indexes.sqlite3"
        with self._db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS receipts (kind TEXT PRIMARY KEY, revision TEXT, "
                "generation TEXT, config TEXT, state TEXT)"
            )
            db.execute(
                "INSERT OR IGNORE INTO metadata VALUES ('namespace', ?)", (uuid.uuid4().hex,)
            )
            self.namespace = str(
                db.execute("SELECT value FROM metadata WHERE key='namespace'").fetchone()[0]
            )

    @contextmanager
    def _db(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.db_path, timeout=10)
        try:
            with db:
                db.execute("PRAGMA synchronous=FULL")
                yield db
        finally:
            db.close()

    def close(self) -> None:
        for adapter in self.adapters.values():
            client = getattr(adapter, "client", None) or getattr(adapter, "driver", None)
            if client is not None:
                client.close()

    def _receipt(self, kind: str) -> dict[str, Any] | None:
        with self._db() as db:
            row = db.execute(
                "SELECT revision,generation,config,state FROM receipts WHERE kind=?", (kind,)
            ).fetchone()
        return (
            dict(zip(("revision", "generation", "config", "state"), row, strict=True))
            if row
            else None
        )

    def status(self) -> dict[str, Any]:
        revision = self.store._head() or None
        states: dict[str, Any] = {}
        for kind in ("graph", "vector"):
            receipt = self._receipt(kind)
            configured = kind in self.adapters
            if not configured:
                state = "not_configured"
            elif (
                not revision
                or not receipt
                or receipt["config"] != self.config_id
                or receipt["revision"] != revision
            ):
                state = "pending"
            else:
                state = "current" if receipt["state"] == "ready" else "error"
            states[kind] = {
                "state": state,
                "indexed_revision": receipt["revision"] if receipt else None,
            }
        return {"revision": revision, "indexes": states}

    def run_once(self, *, rebuild: bool = False) -> dict[str, Any]:
        with (self.store.path / ".wiki-index-worker.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {**self.status(), "worker": "busy"}
            snapshot = self.store.snapshot()
            if not snapshot["revision"]:
                return {**self.status(), "worker": "idle"}
            for kind, adapter in self.adapters.items():
                receipt = self._receipt(kind)
                if (
                    not rebuild
                    and receipt
                    and (
                        receipt["revision"] == snapshot["revision"]
                        and receipt["config"] == self.config_id
                        and receipt["state"] == "ready"
                    )
                ):
                    continue
                generation = self.namespace + "_" + uuid.uuid4().hex
                state = "ready"
                try:
                    adapter.build(generation, snapshot)
                except Exception:
                    # Provider exceptions may contain credentials or private text.
                    # Never put raw messages in public status/logs or receipts.
                    state = "error"
                with self._db() as db:
                    db.execute(
                        "INSERT OR REPLACE INTO receipts VALUES (?,?,?,?,?)",
                        (kind, snapshot["revision"], generation, self.config_id, state),
                    )
            return {**self.status(), "worker": "completed"}

    def _current(self, kind: str) -> tuple[dict[str, Any], dict[str, Any]]:
        snapshot = self.store.snapshot()
        receipt = self._receipt(kind)
        if kind not in self.adapters:
            raise WikiError("index_not_configured", "This optional index is not configured.")
        if not receipt or (
            receipt["revision"] != snapshot["revision"]
            or receipt["config"] != self.config_id
            or receipt["state"] != "ready"
        ):
            raise WikiError("index_pending", "The index has not completed this content revision.")
        return snapshot, receipt

    def semantic_search(self, query: str, limit: int = 10) -> dict[str, Any]:
        snapshot, receipt = self._current("vector")
        try:
            hits = self.adapters["vector"].search(
                receipt["generation"], query[:500], min(50, max(1, limit))
            )
        except Exception as exc:
            raise WikiError("index_unavailable", "The vector provider is unavailable.") from exc
        pages = {p["id"]: p for p in snapshot["pages"]}
        results = []
        for hit in hits:
            page = pages.get(hit.get("id"))
            if page and hit.get("revision") == page["revision"]:
                results.append(
                    {
                        **{k: v for k, v in page.items() if k != "markdown"},
                        "score": hit.get("score"),
                    }
                )
        if self.store._head() != snapshot["revision"]:
            raise WikiError("index_pending", "Content changed during search. Retry after indexing.")
        return {"mode": "semantic", "revision": snapshot["revision"], "results": results}

    def neighbors(self, seeds: list[str], hops: int = 1, limit: int = 50) -> dict[str, Any]:
        if not 1 <= hops <= 3 or not 1 <= limit <= 100 or len(seeds) > 20:
            raise WikiError("invalid_payload", "Use up to 20 seeds, 1–3 hops and limit 1–100.")
        for seed in seeds:
            self.store._validate_id(seed)
        snapshot, receipt = self._current("graph")
        try:
            ids = self.adapters["graph"].neighbors(receipt["generation"], seeds, hops, limit)
        except Exception as exc:
            raise WikiError("index_unavailable", "The graph provider is unavailable.") from exc
        selected = set(ids)
        pages = [
            {k: v for k, v in p.items() if k != "markdown"}
            for p in snapshot["pages"]
            if p["id"] in selected
        ][:limit]
        if self.store._head() != snapshot["revision"]:
            raise WikiError(
                "index_pending", "Content changed during graph search. Retry after indexing."
            )
        return {"revision": snapshot["revision"], "pages": pages, "hops": hops}

    def graph_search(self, query: str, hops: int = 1) -> dict[str, Any]:
        """Non-generative vector seeds plus bounded graph context at one revision."""
        seeds = self.semantic_search(query)
        expanded = self.neighbors([p["id"] for p in seeds["results"][:10]], hops)
        if seeds["revision"] != expanded["revision"] or self.store._head() != seeds["revision"]:
            raise WikiError(
                "index_pending", "Content changed during retrieval. Retry after indexing."
            )
        seen = {p["id"] for p in seeds["results"]}
        return {
            "mode": "graph_rag",
            "revision": seeds["revision"],
            "results": [{**p, "retrieval": "vector"} for p in seeds["results"]]
            + [{**p, "retrieval": "graph"} for p in expanded["pages"] if p["id"] not in seen],
            "hops": hops,
        }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build configured indexes once; safe to repeat.")
    parser.add_argument("--rebuild", action="store_true")
    args = parser.parse_args()
    import os  # noqa: PLC0415

    from second_brain.wiki.index_config import configured_indexes  # noqa: PLC0415

    path = os.environ.get("SECOND_BRAIN_WIKI_VAULT")
    if not path:
        parser.error("SECOND_BRAIN_WIKI_VAULT is required")
    coordinator = configured_indexes(WikiStore(path))
    try:
        print(json.dumps(coordinator.run_once(rebuild=args.rebuild)))
    finally:
        coordinator.close()


if __name__ == "__main__":
    main()
