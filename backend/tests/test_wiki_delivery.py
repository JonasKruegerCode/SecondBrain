"""Managed delivery recovery against real local Git targets."""

from __future__ import annotations

import fcntl
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore


def git(path: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args]).decode().strip()


def setup(tmp_path: Path) -> tuple[WikiStore, Path, ManagedGitSync]:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    store = WikiStore(tmp_path / "vault")
    store.save_page("Alpha", "# Alpha", None, "create")
    return store, remote, ManagedGitSync(store, str(remote), "wiki", "notes")


def edit(store: WikiStore, request: str = "edit") -> str:
    page = store.get_page("Alpha")
    assert page
    store.save_page("Alpha", "# " + request, page["revision"], request)
    return store._head()


def test_restart_receipts_status_offline_and_new_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, remote, sync = setup(tmp_path)
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=None
    )
    initial = store._head()
    assert delivery.status()["remote"]["state"] == "pending"
    assert delivery.run_once()["remote"]["state"] == "current"
    published = git(remote, "rev-parse", "wiki")
    restarted = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=None
    )
    assert restarted.status()["remote"] == {
        "state": "current",
        "last_published_content_revision": initial,
        "last_verified_remote_revision": published,
        "cached_verification": True,
    }

    def offline(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("status and acknowledged revision must not contact remote")

    monkeypatch.setattr(sync, "push", offline)
    assert restarted.run_once()["remote"]["state"] == "current"
    latest = edit(store)
    assert restarted.status()["remote"]["state"] == "pending"
    assert restarted.run_once()["remote"]["state"] == "error"
    assert store._head() == latest
    with sqlite3.connect(delivery.db_path) as db:
        assert str(remote) not in repr(db.execute("SELECT * FROM targets").fetchall())


def test_no_remote_baseline_discovery(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, _, sync = setup(tmp_path)
    monkeypatch.setattr(sync, "inspect", lambda: pytest.fail("must not inspect"))
    monkeypatch.setattr(sync, "_fetch", lambda: pytest.fail("must not discover baseline"))
    with pytest.raises(WikiError) as error:
        DeliveryCoordinator(store, IndexCoordinator(store), sync)
    assert error.value.code == "remote_bootstrap_required"
    coordinator = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=None
    )
    assert coordinator.status()["remote"]["state"] == "pending"
    with pytest.raises(WikiError):
        DeliveryCoordinator(store, IndexCoordinator(store), sync, expected_remote_revision="a" * 40)


def test_lost_ack_recovery_replays_frozen_payload_before_new_write(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, remote, sync = setup(tmp_path)
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=None
    )
    initial = store._head()
    original = sync._run

    def lost(*args: str, **kwargs: Any) -> bytes:
        result = original(*args, **kwargs)
        if args[0] == "push":
            raise WikiError("remote_unavailable", "secret URL lost reply")
        return result

    monkeypatch.setattr(sync, "_run", lost)
    assert delivery.run_once()["remote"]["state"] == "error"
    published = git(remote, "rev-parse", "wiki")
    latest = edit(store)
    restarted_sync = ManagedGitSync(store, str(remote), "wiki", "notes")
    restarted = DeliveryCoordinator(store, IndexCoordinator(store), restarted_sync)
    recovered = restarted.run_once()["remote"]
    assert recovered["state"] == "pending"
    assert recovered["last_published_content_revision"] == initial
    assert git(remote, "rev-parse", "wiki") == published
    assert restarted.run_once()["remote"]["state"] == "current"
    assert restarted.status()["remote"]["last_published_content_revision"] == latest
    assert git(remote, "rev-list", "--count", "wiki") == "2"


def test_independent_provider_failure_and_exact_receipts(tmp_path: Path) -> None:
    store, _, sync = setup(tmp_path)

    class Broken:
        def build(self, generation: str, snapshot: dict[str, Any]) -> None:
            raise RuntimeError("private provider URL")

    coordinator = DeliveryCoordinator(
        store, IndexCoordinator(store, {"graph": Broken()}), sync, expected_remote_revision=None
    )
    receipt = coordinator.save_page("Beta", "# Beta", None, "beta")
    assert coordinator.save_page("Beta", "# Beta", None, "beta") == receipt
    status = coordinator.run_once()
    assert status["indexes"]["graph"]["state"] == "error"
    assert status["remote"]["state"] == "current"
    page = store.get_page("Beta")
    assert page
    deleted = coordinator.delete_page("Beta", page["revision"], "delete")
    assert coordinator.delete_page("Beta", page["revision"], "delete") == deleted
    assert "private" not in str(status)


def test_external_move_blocks_and_never_adopts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, remote, sync = setup(tmp_path)
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=None
    )
    delivery.run_once()
    acknowledged = git(remote, "rev-parse", "wiki")
    git(remote, "update-ref", "-d", "refs/heads/wiki")
    edit(store)
    status = delivery.run_once()["remote"]
    assert status["state"] == "conflict"
    assert status["last_verified_remote_revision"] == acknowledged
    monkeypatch.setattr(
        sync, "push", lambda *args: pytest.fail("conflict must block further automatic publication")
    )
    assert delivery.run_once()["remote"]["state"] == "conflict"
    restarted = DeliveryCoordinator(store, IndexCoordinator(store), sync)
    assert restarted.run_once()["remote"]["state"] == "conflict"


def test_write_during_push_and_lock_contention(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, remote, sync = setup(tmp_path)
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=None
    )
    original = sync._run

    def changed(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "push":
            edit(store)
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "_run", changed)
    assert delivery.run_once()["remote"]["state"] == "pending"
    assert git(remote, "show", "wiki:notes/Alpha.md") == "# Alpha"
    with (store.path / ".wiki-delivery-worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert delivery.run_once()["worker"] == "busy"


def test_indexes_without_remote(tmp_path: Path) -> None:
    store = WikiStore(tmp_path / "vault")
    delivery = DeliveryCoordinator(store, IndexCoordinator(store))
    assert delivery.run_once()["worker"] == "idle"
    assert delivery.status()["remote"]["state"] == "not_configured"


def test_remote_failure_does_not_suppress_index_build(tmp_path: Path) -> None:
    store, remote, sync = setup(tmp_path)
    remote.rename(tmp_path / "offline.git")

    class Ready:
        def build(self, generation: str, snapshot: dict[str, Any]) -> None:
            assert snapshot["revision"] == store._head()

    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store, {"vector": Ready()}),
        sync,
        expected_remote_revision=None,
    )
    status = coordinator.run_once()
    assert status["indexes"]["vector"]["state"] == "current"
    assert status["remote"]["state"] == "error"


def test_explicit_empty_baseline_cannot_adopt_existing_remote(tmp_path: Path) -> None:
    store, remote, sync = setup(tmp_path)
    existing = sync.push(store._head(), None, "manual")["published_revision"]
    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store),
        sync,
        expected_remote_revision=None,
    )
    assert coordinator.run_once()["remote"]["state"] == "conflict"
    assert git(remote, "rev-parse", "wiki") == existing
    assert coordinator.status()["remote"]["last_verified_remote_revision"] is None


def test_external_descendant_during_lost_ack_is_not_adopted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, remote, sync = setup(tmp_path)
    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store),
        sync,
        expected_remote_revision=None,
    )
    original = sync._run

    def lost(*args: str, **kwargs: Any) -> bytes:
        result = original(*args, **kwargs)
        if args[0] == "push":
            raise WikiError("remote_unavailable", "lost response")
        return result

    monkeypatch.setattr(sync, "_run", lost)
    coordinator.run_once()
    published = git(remote, "rev-parse", "wiki")
    tree = git(remote, "rev-parse", "wiki^{tree}")
    descendant = (
        subprocess.run(
            [
                "git",
                "-C",
                str(remote),
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@localhost",
                "commit-tree",
                tree,
                "-p",
                published,
            ],
            input=b"external change\n",
            capture_output=True,
            check=True,
        )
        .stdout.decode()
        .strip()
    )
    git(remote, "update-ref", "refs/heads/wiki", descendant)
    resumed_sync = ManagedGitSync(store, str(remote), "wiki", "notes")
    resumed = DeliveryCoordinator(store, IndexCoordinator(store), resumed_sync)
    status = resumed.run_once()["remote"]
    assert status["state"] == "conflict"
    assert status["last_verified_remote_revision"] == descendant
    edit(store)
    assert resumed.run_once()["remote"]["state"] == "conflict"
    assert git(remote, "rev-parse", "wiki") == descendant


def add_external_asset(tmp_path: Path, remote: Path) -> str:
    checkout = tmp_path / "external"
    subprocess.run(
        ["git", "clone", "--branch", "wiki", str(remote), str(checkout)],
        check=True,
        capture_output=True,
    )
    (checkout / "notes" / "asset.txt").write_text("preserve me")
    git(checkout, "add", ".")
    git(
        checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "external asset",
    )
    git(checkout, "push", "origin", "wiki")
    return git(remote, "rev-parse", "wiki")


def test_reconcile_reviewed_pointer_guards_and_preserves_asset(tmp_path: Path) -> None:
    store, remote, sync = setup(tmp_path)
    first = sync.push(store._head(), None, "manual")["published_revision"]
    reviewed = add_external_asset(tmp_path, remote)
    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store),
        sync,
        expected_remote_revision=None,
    )
    assert coordinator.run_once()["remote"]["state"] == "conflict"
    with pytest.raises(WikiError) as stale:
        coordinator.reconcile_remote(store._head(), first)
    assert stale.value.code == "remote_conflict"
    with pytest.raises(WikiError) as local:
        coordinator.reconcile_remote("0" * 40, reviewed)
    assert local.value.code == "revision_conflict"
    with (store.path / ".wiki-delivery-worker.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(WikiError) as busy:
            coordinator.reconcile_remote(store._head(), reviewed)
        assert busy.value.code == "delivery_busy"
    head = store._head()
    assert coordinator.reconcile_remote(head, reviewed)["remote"]["state"] == "pending"
    assert store._head() == head
    assert git(remote, "rev-parse", "wiki") == reviewed
    with pytest.raises(WikiError):
        coordinator.reconcile_remote(head, reviewed)
    assert coordinator.run_once()["remote"]["state"] == "current"
    assert git(remote, "show", "wiki:notes/asset.txt") == "preserve me"
    assert git(remote, "rev-parse", "wiki^") == reviewed
    # Original environment bootstrap still works after explicit operator recovery.
    DeliveryCoordinator(store, IndexCoordinator(store), sync, expected_remote_revision=None)


def test_reconcile_offline_and_local_write_during_inspection_stays_blocked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, remote, sync = setup(tmp_path)
    reviewed = sync.push(store._head(), None, "manual")["published_revision"]
    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store),
        sync,
        expected_remote_revision=None,
    )
    coordinator.run_once()

    def offline() -> dict[str, Any]:
        raise RuntimeError("private remote URL")

    monkeypatch.setattr(sync, "inspect", offline)
    with pytest.raises(WikiError) as unavailable:
        coordinator.reconcile_remote(store._head(), reviewed)
    assert unavailable.value.code == "remote_unavailable"
    assert "private" not in str(unavailable.value)
    assert coordinator.status()["remote"]["state"] == "conflict"

    def race() -> dict[str, Any]:
        edit(store)
        return {"observed_remote_revision": reviewed}

    monkeypatch.setattr(sync, "inspect", race)
    with pytest.raises(WikiError) as changed:
        coordinator.reconcile_remote(store._head(), reviewed)
    assert changed.value.code == "revision_conflict"
    assert coordinator.status()["remote"]["state"] == "conflict"
    assert git(remote, "rev-parse", "wiki") == reviewed


def test_reconcile_same_content_uses_distinct_guarded_request(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, remote, sync = setup(tmp_path)
    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store),
        sync,
        expected_remote_revision=None,
    )
    original = sync._run

    def lost(*args: str, **kwargs: Any) -> bytes:
        result = original(*args, **kwargs)
        if args[0] == "push":
            raise WikiError("remote_unavailable", "lost response")
        return result

    monkeypatch.setattr(sync, "_run", lost)
    coordinator.run_once()
    reviewed = add_external_asset(tmp_path, remote)
    fresh_sync = ManagedGitSync(store, str(remote), "wiki", "notes")
    resumed = DeliveryCoordinator(store, IndexCoordinator(store), fresh_sync)
    assert resumed.run_once()["remote"]["state"] == "conflict"
    prior = resumed.status()["remote"]["last_published_content_revision"]
    assert prior == store._head()
    resumed.reconcile_remote(store._head(), reviewed)
    assert resumed.status()["remote"]["last_published_content_revision"] == prior
    assert resumed.run_once()["remote"]["state"] == "current"
    with sqlite3.connect(fresh_sync.receipts) as db:
        assert db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 2
    assert git(remote, "show", "wiki:notes/asset.txt") == "preserve me"
    assert git(remote, "rev-parse", "wiki^") == reviewed


def test_reconcile_reviewed_deleted_branch(tmp_path: Path) -> None:
    store, remote, sync = setup(tmp_path)
    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store),
        sync,
        expected_remote_revision=None,
    )
    coordinator.run_once()
    git(remote, "update-ref", "-d", "refs/heads/wiki")
    edit(store)
    assert coordinator.run_once()["remote"]["state"] == "conflict"
    coordinator.reconcile_remote(store._head(), None)
    assert coordinator.run_once()["remote"]["state"] == "current"
    assert git(remote, "rev-list", "--count", "wiki") == "1"


def test_reconcile_epoch_does_not_reuse_ack_after_remote_aba(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, remote, sync = setup(tmp_path)
    coordinator = DeliveryCoordinator(
        store,
        IndexCoordinator(store),
        sync,
        expected_remote_revision=None,
    )
    original = sync._run

    def lost(*args: str, **kwargs: Any) -> bytes:
        result = original(*args, **kwargs)
        if args[0] == "push":
            raise WikiError("remote_unavailable", "lost response")
        return result

    monkeypatch.setattr(sync, "_run", lost)
    coordinator.run_once()
    add_external_asset(tmp_path, remote)
    fresh_sync = ManagedGitSync(store, str(remote), "wiki", "notes")
    resumed = DeliveryCoordinator(store, IndexCoordinator(store), fresh_sync)
    assert resumed.run_once()["remote"]["state"] == "conflict"
    # Return the target to the original empty pointer with identical local content.
    # An old request receipt must not make this publication skip the actual push.
    git(remote, "update-ref", "-d", "refs/heads/wiki")
    resumed.reconcile_remote(store._head(), None)
    assert resumed.run_once()["remote"]["state"] == "current"
    assert git(remote, "show", "wiki:notes/Alpha.md") == "# Alpha"
    with sqlite3.connect(fresh_sync.receipts) as db:
        assert db.execute("SELECT COUNT(*) FROM requests").fetchone()[0] == 2
    with sqlite3.connect(resumed.db_path) as db:
        assert db.execute("SELECT epoch FROM targets").fetchone()[0] == 1
