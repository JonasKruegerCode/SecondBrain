"""Opt-in remote configuration and lifecycle-owned recoverable delivery worker."""

from __future__ import annotations

import fcntl
import hashlib
import os
import threading
from typing import Any

from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore


def configured_delivery(store: WikiStore, indexes: IndexCoordinator) -> DeliveryCoordinator:
    """Honor configured legacy Git automatically; explicit disable always wins."""
    enabled = os.environ.get("SECOND_BRAIN_WIKI_GIT_SYNC", "").strip()
    if enabled == "0":
        return DeliveryCoordinator(store, indexes)
    if enabled not in {"", "1"}:
        raise ValueError("Managed Git enable flag must be 0, 1 or unset.")
    from second_brain.wiki.git_config import legacy_git_settings  # noqa: PLC0415

    explicit_target = (
        os.environ.get("SECOND_BRAIN_WIKI_GIT_REMOTE", "").strip() if enabled == "1" else ""
    )
    legacy_target, legacy_branch, credentials, legacy_trust = legacy_git_settings(explicit_target)
    target = explicit_target or legacy_target
    if not target and enabled != "1":
        return DeliveryCoordinator(store, indexes)
    mode = os.environ.get(
        "SECOND_BRAIN_WIKI_GIT_MODE", "publish" if enabled == "1" and explicit_target else "sync"
    )
    if mode not in {"publish", "sync"}:
        raise ValueError("Managed Git mode must be publish or sync.")
    branch = os.environ.get("SECOND_BRAIN_WIKI_GIT_BRANCH", "").strip() or (
        "" if explicit_target else legacy_branch
    )
    if not target or (mode == "publish" and not branch):
        raise ValueError("Explicit managed Git target and branch are required.")
    prefix = os.environ.get(
        "SECOND_BRAIN_WIKI_GIT_PREFIX", "" if explicit_target else "1_knowledge/wiki"
    )
    remote = ManagedGitSync(
        store,
        target,
        branch or "main",
        prefix,
        ssh_known_hosts=os.environ.get("SECOND_BRAIN_WIKI_GIT_SSH_KNOWN_HOSTS") or legacy_trust,
        credentials=credentials,
    )
    if not branch:
        remote.branch = remote.discover_branch()
    if mode == "sync":
        return _synchronized_delivery(store, indexes, remote)
    baseline = os.environ.get("SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION")
    if baseline is None:
        return DeliveryCoordinator(store, indexes, remote)
    if baseline != "empty" and (
        len(baseline) != 40 or any(c not in "0123456789abcdef" for c in baseline)
    ):
        raise ValueError("Expected remote revision must be a reviewed commit hash or 'empty'.")
    return DeliveryCoordinator(
        store, indexes, remote, expected_remote_revision=None if baseline == "empty" else baseline
    )


def _synchronized_delivery(
    store: WikiStore, indexes: IndexCoordinator, remote: ManagedGitSync
) -> DeliveryCoordinator:
    """Bootstrap an empty wiki before serving; never adopt unrelated local data."""
    with (store.path / ".wiki-delivery-worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            delivery = DeliveryCoordinator(store, indexes, remote, synchronize=True)
        except WikiError as exc:
            if exc.code != "remote_bootstrap_required":
                raise
            observed = remote.inspect()["observed_remote_revision"]
            local = store._head()
            pages = store._snapshot_blobs(local, "pages/") if local else {}
            if pages:
                incoming = remote._markdown(observed) if observed else {}
                same = {
                    name.removeprefix("pages/").removesuffix(".md"): data
                    for name, data in pages.items()
                } == {page_id: data for page_id, (_, data) in incoming.items()}
                if not same:
                    raise WikiError(
                        "remote_bootstrap_conflict",
                        "Existing local content differs; review before connecting Git.",
                    ) from None
            elif observed and remote._markdown(observed):
                request = (
                    "sync-bootstrap:"
                    + hashlib.sha256(
                        (remote.remote + remote.branch + remote.prefix + observed + local).encode()
                    ).hexdigest()
                )
                remote.pull(local or None, observed, request)
            delivery = DeliveryCoordinator(
                store, indexes, remote, expected_remote_revision=observed, synchronize=True
            )
        delivery.indexes.run_once()
        return delivery


class DeliveryWorker:
    """Signals are hints: pending work is reconstructed from durable heads/receipts.

    One worker per transport process is safe: coordinator locks serialize jobs.
    Polling also discovers writes made through the other process. Shutdown waits
    for in-flight provider/Git work before closing clients; provider timeout
    configuration still determines how long a graceful stop can take.
    """

    def __init__(self, delivery: DeliveryCoordinator, *, interval: float = 2) -> None:
        if interval <= 0:
            raise ValueError("Delivery interval must be positive.")
        self.delivery, self.interval = delivery, interval
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeError("Delivery worker already started.")
        self._stop.clear()
        self.last_error = None
        self._thread = threading.Thread(target=self._run, name="wiki-delivery", daemon=True)
        try:
            self._thread.start()
        except Exception:
            self._thread = None
            raise

    def notify(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def status(self) -> dict[str, Any]:
        return {
            **self.delivery.status(),
            "background_worker": {
                "state": "error" if self.last_error else "running" if self._thread else "stopped",
                "error": self.last_error,
            },
        }

    def _run(self) -> None:
        failures = 0
        while not self._stop.is_set():
            self._wake.clear()
            try:
                result = self.delivery.run_once()
                failed = result["remote"]["state"] == "error" or any(
                    value["state"] == "error" for value in result["indexes"].values()
                )
                failures = min(5, failures + 1) if failed else 0
                self.last_error = None
            except Exception:
                # Never persist or return provider messages, URLs or private text.
                self.last_error = "delivery_unavailable"
                failures = min(5, failures + 1)
            self._wake.wait(min(60, self.interval * (2**failures)))


def main() -> None:
    import argparse  # noqa: PLC0415
    import json  # noqa: PLC0415

    from second_brain.wiki.index_config import configured_indexes  # noqa: PLC0415
    from second_brain.wiki.store import WikiError  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        description="Run delivery or deliberately reconcile a Git conflict."
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--once", action="store_true")
    action.add_argument("--reconcile", action="store_true")
    parser.add_argument("--base-revision")
    guard = parser.add_mutually_exclusive_group()
    guard.add_argument("--expected-remote-revision")
    guard.add_argument("--remote-empty", action="store_true")
    args = parser.parse_args()
    if args.reconcile and (
        not args.base_revision or not (args.expected_remote_revision or args.remote_empty)
    ):
        parser.error("Reconcile requires reviewed managed and remote heads (or --remote-empty).")
    if args.once and (args.base_revision or args.expected_remote_revision or args.remote_empty):
        parser.error("Revision guards are only used with --reconcile.")
    path = os.environ.get("SECOND_BRAIN_WIKI_VAULT")
    if not path:
        parser.error("SECOND_BRAIN_WIKI_VAULT is required.")
    if args.reconcile and os.environ.get("SECOND_BRAIN_WIKI_GIT_SYNC") != "1":
        parser.error("Reconcile requires an explicitly configured managed Git target.")
    indexes = None
    try:
        store = WikiStore(path)
        indexes = configured_indexes(store)
        delivery = configured_delivery(store, indexes)
        result = (
            delivery.reconcile_remote(args.base_revision, args.expected_remote_revision)
            if args.reconcile
            else delivery.run_once()
        )
        print(json.dumps(result))
    except WikiError as exc:
        print(json.dumps({"error": exc.code, "message": exc.message}))
        raise SystemExit(1) from None
    except ValueError:
        print(
            json.dumps(
                {
                    "error": "invalid_configuration",
                    "message": "Review explicit delivery configuration.",
                }
            )
        )
        raise SystemExit(1) from None
    finally:
        if indexes is not None:
            indexes.close()


if __name__ == "__main__":
    main()
