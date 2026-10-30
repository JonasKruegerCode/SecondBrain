"""Portable recovery must not guess the outcome of an unconfirmed remote push."""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.backup import create_backup, restore_backup
from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args]).decode().strip()


@pytest.mark.parametrize("newer_local", [False, True])
@pytest.mark.parametrize("remote_advanced", [False, True])
def test_restored_lost_push_ack_requires_review_without_republishing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, newer_local: bool, remote_advanced: bool
) -> None:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    source = WikiStore(tmp_path / "source")
    original = source.save_page("home", "# Synthetic original", None, "create-home")
    sync = ManagedGitSync(source, str(remote), "wiki", "notes")
    indexes = IndexCoordinator(source)
    delivery = DeliveryCoordinator(source, indexes, sync, expected_remote_revision=None)
    run: Callable[..., bytes] = sync._run

    def lost_reply(*args: str, **kwargs: Any) -> bytes:
        result = run(*args, **kwargs)
        if args[0] == "push":
            raise WikiError("remote_unavailable", "Synthetic response lost after push")
        return result

    monkeypatch.setattr(sync, "_run", lost_reply)
    assert delivery.run_once()["remote"]["state"] == "error"
    published = git(remote, "rev-parse", "wiki")
    assert git(remote, "show", "wiki:notes/home.md") == "# Synthetic original"
    observed = published
    if remote_advanced:
        tree = git(remote, "rev-parse", "wiki^{tree}")
        observed = git(
            remote,
            "-c",
            "user.name=Synthetic writer",
            "-c",
            "user.email=fixture@example.invalid",
            "commit-tree",
            tree,
            "-p",
            published,
            "-m",
            "Synthetic external descendant",
        )
        git(remote, "update-ref", "refs/heads/wiki", observed, published)
    if newer_local:
        source.save_page("home", "# Synthetic later edit", original["revision"], "edit-home")
    snapshot, history = source.snapshot(), source.history("home")
    indexes.close()
    archive = tmp_path / "backup.tar.gz"
    assert create_backup(source.path, archive)["revision"] == source._head()
    destination = tmp_path / "restored"
    restore_backup(archive, destination)
    restored = WikiStore(destination)
    # Target configuration is supplied independently; prepared remote objects and
    # remote request receipts deliberately are not part of the portable archive.
    assert not (destination / ".wiki-remote.sqlite3").exists()
    assert not (destination / ".wiki-remote.git").exists()
    recovered_indexes = IndexCoordinator(restored)
    recovered = DeliveryCoordinator(
        restored, recovered_indexes, ManagedGitSync(restored, str(remote), "wiki", "notes")
    )
    if newer_local:
        # The frozen pending payload predates the restored content head.
        assert recovered.run_once()["remote"]["state"] == "pending"
    assert recovered.run_once()["remote"]["state"] == "conflict"
    assert recovered.run_once()["remote"]["state"] == "conflict"
    assert git(remote, "rev-parse", "wiki") == observed
    assert git(remote, "rev-list", "--count", "wiki") == ("2" if remote_advanced else "1")
    assert restored.snapshot() == snapshot
    assert restored.history("home") == history
    assert source.snapshot() == snapshot
    assert source._head() == (snapshot["revision"] or "")
    assert restored.save_page("home", "# Synthetic original", None, "create-home") == original
    assert restored.snapshot() == snapshot
    assert recovered.status()["remote"]["last_published_content_revision"] is None
    recovered_indexes.close()
