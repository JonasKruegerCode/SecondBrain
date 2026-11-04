"""Real local Git publication and incoming changes during held model work."""

import threading
import time
from pathlib import Path
from typing import Any

import pytest
from qdrant_client import QdrantClient

from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.delivery_runtime import DeliveryWorker, _synchronized_delivery
from second_brain.wiki.index_adapters import QdrantSnapshotAdapter
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiStore

from .test_wiki_legacy_git import git, repository


def test_push_and_external_pull_finish_while_embedding_is_held(tmp_path: Path) -> None:
    remote, source = repository(tmp_path)
    store = WikiStore(tmp_path / "vault")
    entered, release = threading.Event(), threading.Event()

    class Provider:
        def embed(self, text: str) -> list[float]:
            entered.set()
            if not release.wait(timeout=15):
                raise TimeoutError("Synthetic held provider")
            return [1.0, 0.0]

    client = QdrantClient(":memory:", force_disable_check_same_thread=True)
    indexes = IndexCoordinator(store, {"vector": QdrantSnapshotAdapter(client, Provider(), 2)})
    delivery = _synchronized_delivery(
        store, indexes, ManagedGitSync(store, str(remote), "archive", "1_knowledge/wiki")
    )
    worker = DeliveryWorker(delivery, interval=0.03)
    worker.start()
    try:
        assert entered.wait(timeout=3)
        page = store.get_page("Home")
        assert page is not None
        delivery.save_page("Home", "# Home\nLocal edit during build.", page["revision"], "edit")
        worker.notify()
        deadline = time.monotonic() + 4
        while "Local edit during build" not in git(
            remote, "show", "archive:1_knowledge/wiki/Home.md"
        ):
            assert time.monotonic() < deadline
            time.sleep(0.02)
        assert not release.is_set()
        assert indexes.status()["indexes"]["vector"]["state"] == "pending"
        git(source, "pull", "--no-rebase", "origin", "archive")
        (source / "1_knowledge/wiki/Article.md").write_text(
            "# Article\nExternal edit during build."
        )
        git(source, "add", ".")
        git(source, "commit", "-m", "Synthetic external change")
        git(source, "push", "origin", "archive")
        worker.notify()
        deadline = time.monotonic() + 4
        while "External edit during build" not in (store.get_page("Article") or {})["markdown"]:
            assert time.monotonic() < deadline
            time.sleep(0.02)
        assert not release.is_set()
        release.set()
        worker.notify()
        deadline = time.monotonic() + 5
        while indexes.status()["indexes"]["vector"]["state"] != "current":
            assert time.monotonic() < deadline
            time.sleep(0.02)
    finally:
        release.set()
        worker.stop()
        indexes.close()
    assert worker.status()["background_worker"]["state"] == "stopped"


def test_partial_second_thread_start_failure_joins_started_worker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = WikiStore(tmp_path)
    worker = DeliveryWorker(DeliveryCoordinator(store, IndexCoordinator(store)), interval=0.03)
    start = threading.Thread.start
    calls = 0
    started: list[threading.Thread] = []

    def fail_second(thread: threading.Thread) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("Synthetic second worker start failure")
        start(thread)
        started.append(thread)

    with monkeypatch.context() as patch:
        patch.setattr(threading.Thread, "start", fail_second)
        with pytest.raises(RuntimeError, match="second worker start"):
            worker.start()
    assert all(not thread.is_alive() for thread in started)
    assert worker.status()["background_worker"]["state"] == "stopped"
    try:
        worker.start()
        assert worker.status()["background_worker"]["state"] == "running"
    finally:
        worker.stop()


def test_index_loop_exception_is_sanitized_and_does_not_stop_delivery(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = WikiStore(tmp_path)
    indexes = IndexCoordinator(store)
    delivery = DeliveryCoordinator(store, indexes)
    worker = DeliveryWorker(delivery, interval=0.03)
    entered = threading.Event()

    def fail(**kwargs: Any) -> dict[str, Any]:
        entered.set()
        raise RuntimeError("private source and credential")

    original = indexes.run_once
    monkeypatch.setattr(indexes, "run_once", fail)
    worker.start()
    try:
        assert entered.wait(timeout=3)
        deadline = time.monotonic() + 2
        while worker.status()["background_worker"]["error"] is None:
            assert time.monotonic() < deadline
            time.sleep(0.01)
        assert worker.status()["background_worker"]["error"] == "index_unavailable"
        assert "credential" not in str(worker.status())
        monkeypatch.setattr(indexes, "run_once", original)
        worker.notify()
        deadline = time.monotonic() + 2
        while worker.status()["background_worker"]["error"] is not None:
            assert time.monotonic() < deadline
            time.sleep(0.01)
    finally:
        worker.stop()
