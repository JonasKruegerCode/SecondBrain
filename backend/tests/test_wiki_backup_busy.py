"""Real SQLite contention must terminate safely and allow a later backup."""

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from second_brain.wiki import backup
from second_brain.wiki.store import WikiError, WikiStore


@pytest.mark.parametrize("ledger", backup.SQLITE_FILES)
def test_locked_ledger_cleans_up_and_allows_retry(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, ledger: str
) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic lock recovery", None, "seed")
    before = store.snapshot()
    history = store.history("home")
    source = vault / ledger
    with sqlite3.connect(source) as locked:
        locked.execute("CREATE TABLE synthetic (value TEXT)")
        locked.commit()
        original = source.read_bytes()
        locked.execute("BEGIN EXCLUSIVE")
        monkeypatch.setattr(backup, "SQLITE_BUSY_TIMEOUT", 0.1)
        with pytest.raises(WikiError) as error:
            backup.create_backup(vault, tmp_path / "backup.tar.gz")
        assert error.value.code == "storage_unavailable"
        assert error.value.message == "Backup storage is unavailable."
        assert {p.name for p in tmp_path.iterdir()} == {"vault"}
        assert source.read_bytes() == original
        locked.rollback()
    assert store.snapshot() == before
    assert store.history("home") == history
    archive = tmp_path / "backup.tar.gz"
    assert backup.create_backup(vault, archive)["revision"] == before["revision"]
    restored = tmp_path / "restored"
    backup.restore_backup(archive, restored)
    assert WikiStore(restored).snapshot() == before


def test_cli_busy_timeout_is_structured_and_cleans_up(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic busy CLI", None, "seed")
    before = store.snapshot()
    with sqlite3.connect(vault / backup.SQLITE_FILES[0]) as locked:
        locked.execute("CREATE TABLE synthetic (value TEXT)")
        locked.commit()
        locked.execute("BEGIN EXCLUSIVE")
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "second_brain.wiki.backup",
                "create",
                "--vault",
                str(vault),
                "--archive",
                str(tmp_path / "backup.tar.gz"),
            ],
            env={
                "PATH": os.environ["PATH"],
                "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
            },
            capture_output=True,
            check=False,
            timeout=15,
        )
        assert result.returncode == 1
        assert result.stdout == b""
        assert json.loads(result.stderr) == {
            "error": "storage_unavailable",
            "message": "Backup storage is unavailable.",
        }
        assert {p.name for p in tmp_path.iterdir()} == {"vault"}
        locked.rollback()
    assert store.snapshot() == before


def test_brief_lock_can_clear_during_online_backup(tmp_path: Path) -> None:
    source = tmp_path / "source.sqlite3"
    # Release from another process so the backup observes real SQLite retries.
    code = (
        "import sqlite3,sys,time; c=sqlite3.connect(sys.argv[1]); "
        "c.execute('CREATE TABLE synthetic (value TEXT)'); c.commit(); "
        "c.execute('BEGIN EXCLUSIVE'); print('locked',flush=True); "
        "time.sleep(0.3); c.rollback(); c.close()"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(source)], stdout=subprocess.PIPE, text=True
    )
    try:
        assert process.stdout is not None
        assert process.stdout.readline().strip() == "locked"
        backup._copy_sqlite(source, tmp_path / "copied.sqlite3")
        with sqlite3.connect(tmp_path / "copied.sqlite3") as copied:
            assert copied.execute("SELECT * FROM synthetic").fetchall() == []
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
