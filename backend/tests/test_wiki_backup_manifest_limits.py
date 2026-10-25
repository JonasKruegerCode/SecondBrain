"""Decoder-limit failures must preserve the structured recovery contract."""

import io
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from second_brain.wiki.backup import create_backup, restore_backup
from second_brain.wiki.store import WikiError, WikiStore


@pytest.mark.parametrize(
    "manifest",
    [
        b"[" * 11_000 + b"0" + b"]" * 11_000,
        b"9" * 5_000,
    ],
    ids=["nesting", "integer-digits"],
)
def test_manifest_decoder_limits_leave_no_restore(tmp_path: Path, manifest: bytes) -> None:
    store = WikiStore(tmp_path / "source")
    receipt = store.save_page("home", "# Synthetic recovery\nUnchanged source.", None, "seed")
    before = store.snapshot()
    history = store.history("home")
    valid = tmp_path / "valid.tar.gz"
    create_backup(store.path, valid)
    damaged = tmp_path / "invalid.tar.gz"
    with tarfile.open(valid, "r:gz") as source, tarfile.open(damaged, "w:gz") as target:
        for member in source.getmembers():
            original = source.extractfile(member)
            assert original is not None
            data = manifest if member.name == "manifest.json" else original.read()
            entry = tarfile.TarInfo(member.name)
            entry.size = len(data)
            target.addfile(entry, io.BytesIO(data))
    original_bytes = damaged.read_bytes()
    destination = tmp_path / "restored"
    with pytest.raises(WikiError) as error:
        restore_backup(damaged, destination)
    assert error.value.code == "backup_invalid"
    assert error.value.message == "The archive manifest is invalid."
    assert not destination.exists()
    assert not list(tmp_path.glob(".restored-restore-*"))
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "second_brain.wiki.backup",
            "restore",
            "--archive",
            str(damaged),
            "--vault",
            str(destination),
        ],
        env={
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        },
        capture_output=True,
        check=False,
    )
    assert result.returncode == 1
    assert result.stdout == b""
    assert json.loads(result.stderr) == {
        "error": "backup_invalid",
        "message": "The archive manifest is invalid.",
    }
    assert not destination.exists()
    assert not list(tmp_path.glob(".restored-restore-*"))
    assert damaged.read_bytes() == original_bytes
    assert store.snapshot() == before
    assert store.history("home") == history
    # A rejected input does not prevent recovery from the intact archive.
    assert restore_backup(valid, destination)["revision"] == before["revision"]
    restored = WikiStore(destination)
    assert restored.snapshot() == before
    assert (
        restored.save_page("home", "# Synthetic recovery\nUnchanged source.", None, "seed")
        == receipt
    )
