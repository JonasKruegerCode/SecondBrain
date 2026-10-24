"""Durable, independent index and opt-in remote delivery of managed revisions.

Local Git receipts remain the write acknowledgement. Delivery compares current
content with durable receipts, so notifications are optional and restart safe.
Remote status is always a cached observation, never a live remote assertion.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from typing import Any

from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore

_UNSET = object()


class DeliveryCoordinator:
    def __init__(
        self,
        store: WikiStore,
        indexes: IndexCoordinator,
        remote: ManagedGitSync | None = None,
        *,
        expected_remote_revision: str | None | object = _UNSET,
    ) -> None:
        if indexes.store.path != store.path or (
            remote is not None and remote.store.path != store.path
        ):
            raise ValueError("Delivery indexes and remote must belong to the same managed vault.")
        self.store, self.indexes, self.remote = store, indexes, remote
        self.db_path = store.path / ".wiki-delivery.sqlite3"
        if self.db_path.is_symlink():
            raise WikiError("invalid_vault", "Delivery storage must not be a symlink.")
        self.target: str | None = None
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "CREATE TABLE IF NOT EXISTS targets (target TEXT PRIMARY KEY, "
                "baseline TEXT, expected TEXT, published_content TEXT, verified TEXT, "
                "state TEXT, pending_content TEXT, pending_expected TEXT)"
            )
            if "epoch" not in {row[1] for row in db.execute("PRAGMA table_info(targets)")}:
                db.execute("ALTER TABLE targets ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0")
            if remote is not None:
                self.target = hashlib.sha256(
                    json.dumps(
                        [remote.remote, remote.branch, remote.prefix], separators=(",", ":")
                    ).encode()
                ).hexdigest()
                row = db.execute(
                    "SELECT baseline FROM targets WHERE target=?", (self.target,)
                ).fetchone()
                if row is None:
                    if expected_remote_revision is _UNSET:
                        raise WikiError(
                            "remote_bootstrap_required",
                            "Explicitly configure the expected remote revision before delivery.",
                        )
                    if expected_remote_revision is not None and (
                        not isinstance(expected_remote_revision, str)
                        or not re.fullmatch(r"[0-9a-f]{40}", expected_remote_revision)
                    ):
                        raise WikiError(
                            "invalid_revision",
                            "Expected remote revision must be a commit hash or null.",
                        )
                    db.execute(
                        "INSERT INTO targets "
                        "(target,baseline,expected,published_content,verified,state,"
                        "pending_content,pending_expected) VALUES (?,?,?,?,?,?,?,?)",
                        (
                            self.target,
                            expected_remote_revision,
                            expected_remote_revision,
                            None,
                            None,
                            "pending",
                            None,
                            None,
                        ),
                    )
                elif expected_remote_revision is not _UNSET and expected_remote_revision != row[0]:
                    raise WikiError(
                        "remote_bootstrap_conflict",
                        "The configured bootstrap revision differs from the original baseline.",
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

    def _remote_row(self) -> dict[str, Any] | None:
        if self.target is None:
            return None
        with self._db() as db:
            row = db.execute(
                "SELECT expected,published_content,verified,state,pending_content,"
                "pending_expected,epoch "
                "FROM targets WHERE target=?",
                (self.target,),
            ).fetchone()
        assert row is not None
        return dict(
            zip(
                (
                    "expected",
                    "published_content",
                    "verified",
                    "state",
                    "pending_content",
                    "pending_expected",
                    "epoch",
                ),
                row,
                strict=True,
            )
        )

    def status(self) -> dict[str, Any]:
        # Index status captures one revision; recheck after reading the ledger.
        for _ in range(3):
            result = self.indexes.status()
            row = self._remote_row()
            if self.store._head() == (result["revision"] or ""):
                break
        else:
            result = self.indexes.status()
            for kind, value in result["indexes"].items():
                if kind in self.indexes.adapters:
                    value["state"] = "pending"
            # Continuous writers prevent proving a common current snapshot.
            if row is not None and row["state"] not in {"error", "conflict"}:
                row["state"] = "pending"
        state = "not_configured"
        if row is not None:
            state = row["state"]
            if state not in {"error", "conflict"}:
                state = (
                    "current"
                    if result["revision"]
                    and row["published_content"] == result["revision"]
                    and not row["pending_content"]
                    and state != "pending"
                    else "pending"
                )
        return {
            **result,
            "remote": {
                "state": state,
                "last_published_content_revision": row["published_content"] if row else None,
                "last_verified_remote_revision": row["verified"] if row else None,
                "cached_verification": bool(row and row["verified"]),
            },
        }

    def save_page(
        self, page_id: str, markdown: str, base_revision: str | None, request_id: str
    ) -> dict[str, Any]:
        return self.store.save_page(page_id, markdown, base_revision, request_id)

    def delete_page(self, page_id: str, base_revision: str, request_id: str) -> dict[str, Any]:
        return self.store.delete_page(page_id, base_revision, request_id)

    def reconcile_remote(
        self, base_revision: str, expected_remote_revision: str | None
    ) -> dict[str, Any]:
        """Explicitly accept a reviewed remote pointer for the chosen local head.

        This control action never imports content or publishes it. The following
        worker attempt uses the ordinary guarded, non-force snapshot push.
        """
        with (self.store.path / ".wiki-delivery-worker.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise WikiError(
                    "delivery_busy", "Delivery is active; retry reconciliation."
                ) from exc
            row = self._remote_row()
            if self.remote is None or row is None or row["state"] != "conflict":
                raise WikiError(
                    "reconciliation_not_required", "The target must be blocked by a conflict."
                )
            if not base_revision or self.store._head() != base_revision:
                raise WikiError("revision_conflict", "The reviewed local snapshot changed.")
            try:
                observed = self.remote.inspect()["observed_remote_revision"]
            except Exception as exc:
                raise WikiError(
                    "remote_unavailable", "The reviewed remote pointer could not be verified."
                ) from exc
            if observed != expected_remote_revision:
                raise WikiError("remote_conflict", "The reviewed remote pointer changed.")
            with self._db() as db:
                if self.store._head() != base_revision:
                    raise WikiError("revision_conflict", "The reviewed local snapshot changed.")
                db.execute(
                    "UPDATE targets SET expected=?,verified=?,state='pending',"
                    "pending_content=NULL,pending_expected=NULL,epoch=epoch+1 WHERE target=?",
                    (observed, observed, self.target),
                )
            return self.status()

    def run_once(self, *, rebuild: bool = False) -> dict[str, Any]:
        with (self.store.path / ".wiki-delivery-worker.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return {**self.status(), "worker": "busy"}
            # Provider failures are normally captured per index by its coordinator.
            # A coordinator failure must not suppress independent remote delivery.
            with suppress(Exception):
                self.indexes.run_once(rebuild=rebuild)
            row = self._remote_row()
            revision = self.store._head() or None
            if self.remote is None or row is None or not revision:
                return {**self.status(), "worker": "idle" if not revision else "completed"}
            if row["state"] == "conflict" or (
                row["state"] == "current"
                and row["published_content"] == revision
                and not row["pending_content"]
            ):
                return {**self.status(), "worker": "completed"}
            content = row["pending_content"] or revision
            expected = row["pending_expected"] if row["pending_content"] else row["expected"]
            # Persist the retry payload before any network operation. A newer local
            # head must not change the request fingerprint after a lost response.
            with self._db() as db:
                db.execute(
                    "UPDATE targets SET pending_content=?,pending_expected=?,state='pending' "
                    "WHERE target=?",
                    (content, expected, self.target),
                )
            request = (
                "delivery:"
                + hashlib.sha256(
                    json.dumps(
                        [self.target, content, expected, row["epoch"]], separators=(",", ":")
                    ).encode()
                ).hexdigest()
            )
            try:
                ack = self.remote.push(content, expected, request)
            except Exception as exc:
                code = exc.code if isinstance(exc, WikiError) else "remote_unavailable"
                state = "conflict" if code == "remote_conflict" else "error"
                with self._db() as db:
                    if code == "revision_conflict":
                        db.execute(
                            "UPDATE targets SET pending_content=NULL,pending_expected=NULL,"
                            "state='pending' "
                            "WHERE target=?",
                            (self.target,),
                        )
                    else:
                        db.execute(
                            "UPDATE targets SET state=? WHERE target=?", (state, self.target)
                        )
            else:
                # Recovery can observe an external descendant. Record the ack,
                # but never adopt that external revision as the next push baseline.
                published = ack["published_revision"]
                verified = ack["last_verified_remote_revision"]
                state = "current" if published == verified else "conflict"
                with self._db() as db:
                    db.execute(
                        "UPDATE targets SET expected=?,published_content=?,verified=?,state=?,"
                        "pending_content=NULL,pending_expected=NULL WHERE target=?",
                        (published, content, verified, state, self.target),
                    )
            return {**self.status(), "worker": "completed"}
