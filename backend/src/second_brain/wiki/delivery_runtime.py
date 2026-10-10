"""Opt-in remote configuration and lifecycle-owned recoverable delivery worker."""

from __future__ import annotations

import os
import threading
from typing import Any

from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiStore


def configured_delivery(store: WikiStore, indexes: IndexCoordinator) -> DeliveryCoordinator:
    """Never discover/adopt a remote baseline automatically, or persist a URL/key."""
    if os.environ.get("SECOND_BRAIN_WIKI_GIT_SYNC") != "1":
        return DeliveryCoordinator(store, indexes)
    target = os.environ.get("SECOND_BRAIN_WIKI_GIT_REMOTE")
    branch = os.environ.get("SECOND_BRAIN_WIKI_GIT_BRANCH")
    if not target or not branch:
        raise ValueError("Explicit managed Git target and branch are required.")
    remote = ManagedGitSync(
        store, target, branch, os.environ.get("SECOND_BRAIN_WIKI_GIT_PREFIX", "")
    )
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
        self._thread.start()

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
        parser.error(
            "Reconcile requires reviewed managed and remote heads (or --remote-empty)."
        )
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
