"""A live REST save racing portable backup must never publish mixed content."""

# Real Git/SQLite snapshots and deterministic thread barriers are intentional.
# ruff: noqa: S101, SLF001
from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import pytest
from starlette.testclient import TestClient

from second_brain.wiki import backup
from second_brain.wiki.api import create_app
from second_brain.wiki.store import WikiError


@pytest.mark.parametrize("write_before_bundle", [True, False])
def test_live_rest_save_during_backup_is_rejected_or_restores_one_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, write_before_bundle: bool
) -> None:
    vault, restored = tmp_path / "live", tmp_path / "restored"
    archive = tmp_path / "backup.tar.gz"
    original = {
        "markdown": "# Synthetic home\n\n[[notes]]",
        "base_revision": None,
        "request_id": "create-home",
    }
    reached, release = Event(), Event()
    run_git: Callable[..., bytes] = backup._run_git

    def held_bundle(repo: Path, *args: str) -> bytes:
        if args[:2] != ("bundle", "create"):
            return run_git(repo, *args)
        result = b"" if write_before_bundle else run_git(repo, *args)
        reached.set()
        if not release.wait(10):
            raise RuntimeError("REST writer did not release the backup fixture")
        return run_git(repo, *args) if write_before_bundle else result

    with TestClient(create_app(vault, close_indexes=True)) as client:
        created = client.post("/api/wiki/pages/home", json=original)
        assert created.status_code == 200
        receipt = created.json()
        notes = client.post(
            "/api/wiki/pages/notes",
            json={
                "markdown": "# Synthetic notes",
                "base_revision": None,
                "request_id": "create-notes",
            },
        )
        assert notes.status_code == 200
        before = client.get("/api/wiki/pages/home").json()
        before_history = client.get("/api/wiki/pages/home/history").json()
        before_graph = client.get("/api/wiki/graph").json()
        captured_head = before_graph["revision"]
        edit = {
            "markdown": "# Synthetic home\n\n[[notes]]\n\nSaved during backup.",
            "base_revision": before["revision"],
            "request_id": "concurrent-edit",
        }
        monkeypatch.setattr(backup, "_run_git", held_bundle)
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(backup.create_backup, vault, archive)
            try:
                assert reached.wait(10), "backup did not reach its Git capture boundary"
                changed = client.post("/api/wiki/pages/home", json=edit)
                assert changed.status_code == 200
                saved = client.get("/api/wiki/pages/home").json()
                saved_history = client.get("/api/wiki/pages/home/history").json()
                saved_graph = client.get("/api/wiki/graph").json()
                changed_head = saved_graph["revision"]
                assert changed_head != captured_head
            finally:
                release.set()
            if write_before_bundle:
                with pytest.raises(WikiError) as failed:
                    pending.result(timeout=10)
                assert failed.value.code == "backup_changed"
                assert not archive.exists()
                assert {p.name for p in tmp_path.iterdir()} == {"live"}
            else:
                assert pending.result(timeout=10)["revision"] == captured_head
        monkeypatch.setattr(backup, "_run_git", run_git)
        if write_before_bundle:
            # A deliberate retry captures the completed save without overwriting.
            assert backup.create_backup(vault, archive)["revision"] == changed_head
        assert client.get("/api/wiki/pages/home").json() == saved
        assert len(client.get("/api/wiki/pages/home/history").json()["history"]) == 2
        assert backup.restore_backup(archive, restored)["revision"] == (
            changed_head if write_before_bundle else captured_head
        )
        with TestClient(create_app(restored, close_indexes=True)) as recovered:
            assert recovered.get("/api/wiki/health").status_code == 200
            assert recovered.get("/api/wiki/pages/home").json() == (
                saved if write_before_bundle else before
            )
            assert recovered.get("/api/wiki/pages/home/history").json() == (
                saved_history if write_before_bundle else before_history
            )
            assert recovered.get("/api/wiki/graph").json() == (
                saved_graph if write_before_bundle else before_graph
            )
            assert recovered.get("/api/wiki/pages/notes").json()["markdown"] == (
                "# Synthetic notes"
            )
            head = recovered.get("/api/wiki/graph").json()["revision"]
            replay = recovered.post(
                "/api/wiki/pages/home", json=(edit if write_before_bundle else original)
            )
            assert replay.status_code == 200
            assert replay.json()["revision"] == (
                changed.json()["revision"] if write_before_bundle else receipt["revision"]
            )
            assert recovered.get("/api/wiki/graph").json()["revision"] == head
        assert {p.name for p in tmp_path.iterdir()} == {"live", "backup.tar.gz", "restored"}
