"""Lifecycle, configuration and real transport delivery regressions."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest
from qdrant_client import QdrantClient
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.delivery_runtime import DeliveryWorker, configured_delivery
from second_brain.wiki.index_adapters import QdrantSnapshotAdapter
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.mcp import create_http_app
from second_brain.wiki.store import WikiStore


class RecordingIndex:
    def __init__(self) -> None:
        self.built = threading.Event()
        self.revisions: list[str] = []
        self.closed = False
        self.client = self

    def build(self, generation: str, snapshot: dict[str, Any]) -> None:
        assert not self.closed
        self.revisions.append(snapshot["revision"])
        self.built.set()

    def close(self) -> None:
        self.closed = True


def wait_current(delivery: DeliveryCoordinator) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if delivery.status()["indexes"]["graph"]["state"] == "current":
            return
        time.sleep(0.01)
    raise AssertionError("Background delivery did not settle.")


def test_rest_background_recovery_and_immutable_retry(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    adapter = RecordingIndex()
    indexes = IndexCoordinator(store, {"graph": adapter})
    delivery = DeliveryCoordinator(store, indexes)
    store.save_page("before", "# Before\nRestart pending.", None, "pre-start")
    with TestClient(
        create_app(
            tmp_path,
            indexes=indexes,
            delivery=delivery,
            automatic_delivery=True,
            close_indexes=True,
        )
    ) as client:
        wait_current(delivery)
        payload = {"markdown": "# Harbor\nSynthetic.", "base_revision": None, "request_id": "save"}
        receipt = client.post("/api/wiki/pages/harbor", json=payload).json()
        wait_current(delivery)
        assert client.post("/api/wiki/pages/harbor", json=payload).json() == receipt
        status = client.get("/api/wiki/delivery-status")
        assert status.headers["cache-control"] == "no-store"
        assert status.json()["indexes"]["graph"]["state"] == "current"
        assert status.json()["remote"]["state"] == "not_configured"
        assert status.json()["background_worker"]["state"] == "running"
        deleted = client.request(
            "DELETE",
            "/api/wiki/pages/harbor",
            json={"base_revision": receipt["revision"], "request_id": "delete"},
        )
        assert deleted.status_code == 200
        wait_current(delivery)
    assert adapter.closed


def test_worker_recovers_unhinted_cross_process_write_and_stops(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    adapter = RecordingIndex()
    delivery = DeliveryCoordinator(store, IndexCoordinator(store, {"graph": adapter}))
    worker = DeliveryWorker(delivery, interval=0.03)
    worker.start()
    try:
        WikiStore(tmp_path).save_page("outside", "# Outside\nOther transport.", None, "unhinted")
        wait_current(delivery)
        assert adapter.revisions
    finally:
        worker.stop()
    assert worker.status()["background_worker"]["state"] == "stopped"
    worker.start()
    try:
        WikiStore(tmp_path).save_page("restarted", "# Restarted", None, "restart-lifecycle")
        wait_current(delivery)
    finally:
        worker.stop()


def test_worker_contains_private_exception_and_recovers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    delivery = DeliveryCoordinator(WikiStore(tmp_path), IndexCoordinator(WikiStore(tmp_path)))
    worker = DeliveryWorker(delivery, interval=0.03)
    failed = threading.Event()
    original = delivery.run_once

    def fault() -> dict[str, Any]:
        failed.set()
        raise RuntimeError("private text and secret-token")

    monkeypatch.setattr(delivery, "run_once", fault)
    worker.start()
    try:
        assert failed.wait(2)
        deadline = time.monotonic() + 2
        while worker.last_error is None and time.monotonic() < deadline:
            time.sleep(0.005)
        assert worker.status()["background_worker"]["error"] == "delivery_unavailable"
        assert "secret-token" not in str(worker.status())
        monkeypatch.setattr(delivery, "run_once", original)
        worker.notify()
        deadline = time.monotonic() + 2
        while worker.last_error and time.monotonic() < deadline:
            time.sleep(0.005)
        assert worker.last_error is None
    finally:
        worker.stop()


def test_remote_config_is_explicit_and_invalid_baseline_never_echoed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = WikiStore(tmp_path)
    indexes = IndexCoordinator(store)
    monkeypatch.delenv("SECOND_BRAIN_WIKI_GIT_SYNC", raising=False)
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_REMOTE", "https://secret-token@example.invalid/vault")
    assert configured_delivery(store, indexes).status()["remote"]["state"] == "not_configured"
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_SYNC", "1")
    with pytest.raises(ValueError, match="target and branch"):
        configured_delivery(store, indexes)
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_REMOTE", str(tmp_path.parent / "synthetic.git"))
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_BRANCH", "wiki")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION", "secret-token")
    with pytest.raises(ValueError) as exc:
        configured_delivery(store, indexes)
    assert "secret-token" not in str(exc.value)
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION", "empty")
    assert configured_delivery(store, indexes).status()["remote"]["state"] == "pending"
    monkeypatch.delenv("SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION")
    assert configured_delivery(store, indexes).status()["remote"]["state"] == "pending"


def test_mcp_background_delivery_same_state_as_rest(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    adapter = RecordingIndex()
    indexes = IndexCoordinator(store, {"graph": adapter})
    delivery = DeliveryCoordinator(store, indexes)
    headers = {"Accept": "application/json, text/event-stream"}
    with TestClient(
        create_http_app(store, indexes=indexes, delivery=delivery, automatic_delivery=True),
        base_url="http://localhost",
        headers=headers,
    ) as client:
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "save_page",
                "arguments": {
                    "id": "harbor",
                    "markdown": "# Harbor\nSynthetic.",
                    "base_revision": None,
                    "request_id": "mcp-delivery",
                },
            },
        }
        saved = client.post("/mcp", json=payload).json()["result"]["structuredContent"]
        assert saved["publication"] == "saved"
        wait_current(delivery)
        status = client.post(
            "/mcp",
            json={
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "get_delivery_status", "arguments": {}},
            },
        ).json()["result"]["structuredContent"]
        assert status["indexes"]["graph"]["state"] == "current"
        with TestClient(create_app(tmp_path, indexes=indexes, delivery=delivery)) as rest:
            assert rest.get("/api/wiki/delivery-status").json() == delivery.status()


def test_actual_embedded_vector_delivery_and_semantic_rest(tmp_path: Path) -> None:
    class SyntheticEmbedder:
        def embed(self, text: str) -> list[float]:
            return [1.0, float("harbor" in text.lower())]

    store = WikiStore(tmp_path)
    vector = QdrantSnapshotAdapter(
        QdrantClient(":memory:", force_disable_check_same_thread=True), SyntheticEmbedder(), 2
    )
    indexes = IndexCoordinator(store, {"vector": vector})
    delivery = DeliveryCoordinator(store, indexes)
    with TestClient(
        create_app(
            tmp_path,
            indexes=indexes,
            delivery=delivery,
            automatic_delivery=True,
            close_indexes=True,
        )
    ) as client:
        saved = client.post(
            "/api/wiki/pages/harbor",
            json={"markdown": "# Harbor", "base_revision": None, "request_id": "embedded-delivery"},
        )
        assert saved.status_code == 200
        deadline = time.monotonic() + 5
        while delivery.status()["indexes"]["vector"]["state"] != "current":
            assert time.monotonic() < deadline
            time.sleep(0.01)
        results = client.get("/api/wiki/search?mode=semantic&q=harbor").json()
        assert results["revision"] == delivery.status()["revision"]
        assert results["results"][0]["id"] == "harbor"


def test_operator_cli_reviews_conflict_then_resumes_without_content_write(tmp_path: Path) -> None:
    import json
    import os
    import subprocess
    import sys

    store = WikiStore(tmp_path / "vault")
    remote = tmp_path / "synthetic.git"
    subprocess.run(["git", "init", "--bare", str(remote)], capture_output=True, check=True)
    store.save_page("alpha", "# Alpha\nSynthetic.", None, "first")
    env = {
        **os.environ,
        "SECOND_BRAIN_WIKI_VAULT": str(store.path),
        "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        "SECOND_BRAIN_WIKI_GIT_SYNC": "1",
        "SECOND_BRAIN_WIKI_GIT_REMOTE": str(remote),
        "SECOND_BRAIN_WIKI_GIT_BRANCH": "wiki",
        "SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION": "empty",
        "SECOND_BRAIN_WIKI_GRAPH_INDEX": "0",
        "SECOND_BRAIN_WIKI_VECTOR_INDEX": "0",
    }

    def command(*args: str) -> dict[str, Any]:
        result = subprocess.run(
            [sys.executable, "-m", "second_brain.wiki.delivery_runtime", *args],
            env=env,
            text=True,
            capture_output=True,
            check=True,
        )
        return dict(json.loads(result.stdout))

    assert command("--once")["remote"]["state"] == "current"
    subprocess.run(
        ["git", "--git-dir", str(remote), "update-ref", "-d", "refs/heads/wiki"], check=True
    )
    store.save_page("beta", "# Beta\nSynthetic.", None, "second")
    before = store.snapshot()
    assert command("--once")["remote"]["state"] == "conflict"
    assert (
        command("--reconcile", "--base-revision", store._head(), "--remote-empty")["remote"][
            "state"
        ]
        == "pending"
    )
    assert command("--once")["remote"]["state"] == "current"
    assert store.snapshot() == before
    assert (
        subprocess.check_output(["git", "--git-dir", str(remote), "show", "wiki:beta.md"])
        .decode()
        .startswith("# Beta")
    )
    invalid = subprocess.run(
        [sys.executable, "-m", "second_brain.wiki.delivery_runtime", "--reconcile"],
        env={**env, "SECOND_BRAIN_WIKI_VAULT": str(tmp_path / "not-created")},
        capture_output=True,
    )
    assert invalid.returncode != 0
    assert not (tmp_path / "not-created").exists()
