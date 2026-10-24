"""Portable backup and restore tests with synthetic managed content."""

# Assertions, private revision checks and CLI subprocesses are intentional.
# ruff: noqa: S101, SLF001, S603
from __future__ import annotations

import errno
import hashlib
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
from pathlib import Path
from typing import Literal

import pytest

from second_brain.wiki import backup
from second_brain.wiki.backup import create_backup, restore_backup
from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiError, WikiStore


@pytest.mark.parametrize(
    ("vault_name", "restored_name"),
    [
        ("vault", "restored"),
        ("vault?query", "restored"),
        ("vault#fragment", "restored"),
        ("vault%3Fliteral", "restored"),
        ("vault", "restored?query"),
        ("vault", "restored#fragment"),
        ("vault", "restored%3Fliteral"),
        ("vault with spaces ü", "restored with spaces ü"),
    ],
)
def test_backup_restores_history_receipts_and_local_metadata(
    tmp_path: Path, vault_name: str, restored_name: str
) -> None:
    vault = tmp_path / vault_name
    store = WikiStore(vault)
    created = store.save_page("home", "# Synthetic home\n\n[[notes]]", None, "create-home")
    notes = store.save_page("notes", "# Synthetic notes", None, "create-notes")
    store.save_page("notes", "# Synthetic notes\n\nEdited.", notes["revision"], "edit-notes")
    revision = store._head()
    indexes = IndexCoordinator(store)
    namespace = indexes.namespace
    DeliveryCoordinator(store, indexes)
    indexes.close()
    marker = b'{"fixture":"synthetic"}\n'
    (vault / ".second-brain-demo.json").write_bytes(marker)

    archive = tmp_path / "wiki-backup.tar.gz"
    result = create_backup(vault, archive)
    assert result == {
        "operation": "backup",
        "archive": str(archive),
        "revision": revision,
        "page_count": 2,
        "provider_data_included": False,
    }

    store.save_page("later", "# Later synthetic page", None, "later")
    restored_path = tmp_path / restored_name
    restored_result = restore_backup(archive, restored_path)
    assert restored_result["revision"] == revision
    assert restored_result["page_count"] == 2
    restored = WikiStore(restored_path)
    assert restored._head() == revision
    assert restored.get_page("later") is None
    assert restored.get_page("notes")["markdown"].endswith("Edited.")  # type: ignore[index]
    assert len(restored.history("notes")) == 2
    replayed = restored.save_page("home", "# Synthetic home\n\n[[notes]]", None, "create-home")
    assert replayed == created
    assert (restored_path / ".second-brain-demo.json").read_bytes() == marker
    restored_indexes = IndexCoordinator(restored)
    assert restored_indexes.namespace == namespace
    DeliveryCoordinator(restored, restored_indexes)
    restored_indexes.close()
    for name in (".wiki-indexes.sqlite3", ".wiki-delivery.sqlite3"):
        with sqlite3.connect(restored_path / name) as db:
            assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    assert {item.name for item in tmp_path.iterdir()} == {
        vault_name, archive.name, restored_name
    }


def test_empty_backup_restore_and_no_overwrite(tmp_path: Path) -> None:
    vault = tmp_path / "empty"
    WikiStore(vault)
    archive = tmp_path / "empty.tar.gz"
    assert create_backup(vault, archive)["revision"] is None
    with pytest.raises(WikiError, match="new archive"):
        create_backup(vault, archive)
    restored_path = tmp_path / "restored"
    assert restore_backup(archive, restored_path)["page_count"] == 0
    assert WikiStore(restored_path).snapshot()["pages"] == []
    with pytest.raises(WikiError, match="new directory"):
        restore_backup(archive, restored_path)


def test_unsafe_metadata_and_invalid_archive_leave_no_restore(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    WikiStore(vault)
    (vault / ".wiki-indexes.sqlite3").symlink_to(tmp_path / "outside")
    with pytest.raises(WikiError, match="symbolic link"):
        create_backup(vault, tmp_path / "unsafe.tar.gz")
    assert not (tmp_path / "unsafe.tar.gz").exists()

    invalid = tmp_path / "invalid.tar.gz"
    invalid.write_bytes(b"not an archive")
    destination = tmp_path / "invalid-restore"
    with pytest.raises(WikiError, match="archive is invalid"):
        restore_backup(invalid, destination)
    assert not destination.exists()


def test_checksum_mismatch_is_rejected_before_publication(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic checksum page", None, "checksum")
    archive = tmp_path / "valid.tar.gz"
    create_backup(vault, archive)
    tampered = tmp_path / "tampered.tar.gz"
    with tarfile.open(archive, "r:gz") as source, tarfile.open(tampered, "w:gz") as target:
        for member in source.getmembers():
            fileobj = source.extractfile(member)
            assert fileobj is not None
            data = fileobj.read() + (b"tampered" if member.name == "content.bundle" else b"")
            copied = tarfile.TarInfo(member.name)
            copied.size = len(data)
            target.addfile(copied, io.BytesIO(data))
    destination = tmp_path / "restored"
    with pytest.raises(WikiError, match="checksum"):
        restore_backup(tampered, destination)
    assert not destination.exists()


@pytest.mark.parametrize("restored_name", ["restored", "restored?query", "restored#fragment"])
@pytest.mark.parametrize("ledger", [".wiki-indexes.sqlite3", ".wiki-delivery.sqlite3"])
def test_invalid_sqlite_is_rejected_before_restore_publication(
    tmp_path: Path, restored_name: str, ledger: str
) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic ledger integrity", None, "ledger-home")
    indexes = IndexCoordinator(store)
    DeliveryCoordinator(store, indexes)
    indexes.close()
    before = store.snapshot()
    archive = tmp_path / "valid.tar.gz"
    create_backup(vault, archive)
    with tarfile.open(archive, "r:gz") as source:
        entries = {}
        for member in source.getmembers():
            fileobj = source.extractfile(member)
            assert fileobj is not None
            entries[member.name] = fileobj.read()
    name = f"metadata/{ledger}"
    invalid = b"not a SQLite database"
    entries[name] = invalid
    manifest = json.loads(entries["manifest.json"])
    manifest["files"][name] = {"sha256": hashlib.sha256(invalid).hexdigest(), "bytes": len(invalid)}
    entries["manifest.json"] = json.dumps(manifest).encode()
    damaged = tmp_path / "invalid-ledger.tar.gz"
    with tarfile.open(damaged, "w:gz") as output:
        for name, data in entries.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            output.addfile(member, io.BytesIO(data))
    destination = tmp_path / restored_name
    expected_files = {vault.name, archive.name, damaged.name}

    with pytest.raises(WikiError) as error:
        restore_backup(damaged, destination)
    assert error.value.code == "backup_invalid"
    assert {item.name for item in tmp_path.iterdir()} == expected_files
    assert store.snapshot() == before

    cli = subprocess.run(
        [sys.executable, "-m", "second_brain.wiki.backup", "restore",
         "--archive", str(damaged), "--vault", str(destination)],
        env={
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        },
        capture_output=True,
        check=False,
    )
    assert cli.returncode == 1
    assert json.loads(cli.stderr)["error"] == "backup_invalid"
    assert cli.stdout == b""
    assert {item.name for item in tmp_path.iterdir()} == expected_files
    assert store.snapshot() == before


@pytest.mark.parametrize("suffix", ["", " ?#%3F ü"])
def test_cli_round_trip(tmp_path: Path, suffix: str) -> None:
    vault = tmp_path / f"vault{suffix}"
    store = WikiStore(vault)
    store.save_page("home", "# CLI synthetic home", None, "cli-home")
    indexes = IndexCoordinator(store)
    namespace = indexes.namespace
    DeliveryCoordinator(store, indexes)
    indexes.close()
    archive = tmp_path / "cli.tar.gz"
    restored = tmp_path / f"restored{suffix}"
    cwd = Path(__file__).resolve().parents[1]
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(cwd / "src")}
    create = subprocess.run(
        [
            sys.executable,
            "-m",
            "second_brain.wiki.backup",
            "create",
            "--vault",
            str(vault),
            "--archive",
            str(archive),
        ],
        cwd=cwd,
        env=env,
        capture_output=True,
        check=False,
    )
    assert create.returncode == 0, create.stderr
    assert json.loads(create.stdout)["page_count"] == 1
    restore = subprocess.run(
        [
            sys.executable,
            "-m",
            "second_brain.wiki.backup",
            "restore",
            "--archive",
            str(archive),
            "--vault",
            str(restored),
        ],
        cwd=cwd,
        env=env,
        capture_output=True,
        check=False,
    )
    assert restore.returncode == 0, restore.stderr
    assert json.loads(restore.stdout)["page_count"] == 1
    page = WikiStore(restored).get_page("home")
    assert page is not None
    assert page["title"] == "CLI synthetic home"
    restored_indexes = IndexCoordinator(WikiStore(restored))
    assert restored_indexes.namespace == namespace
    restored_indexes.close()
    assert {item.name for item in tmp_path.iterdir()} == {vault.name, archive.name, restored.name}


@pytest.mark.parametrize("removed", [1, 8, 16, 32])
def test_truncated_compression_is_rejected_before_restore_publication(
    tmp_path: Path, removed: int
) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic backup integrity", None, "integrity-home")
    before = store.snapshot()
    archive = tmp_path / "valid.tar.gz"
    create_backup(vault, archive)
    damaged = tmp_path / "damaged.tar.gz"
    damaged.write_bytes(archive.read_bytes()[:-removed])
    destination = tmp_path / "restored"

    with pytest.raises(WikiError) as error:
        restore_backup(damaged, destination)
    assert error.value.code == "backup_invalid"
    assert not destination.exists()
    assert not list(tmp_path.glob(".restored-restore-*"))
    assert store.snapshot() == before

    cli = subprocess.run(
        [sys.executable, "-m", "second_brain.wiki.backup", "restore",
         "--archive", str(damaged), "--vault", str(destination)],
        env={
            "PATH": os.environ["PATH"],
            "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
        },
        capture_output=True,
        check=False,
    )
    assert cli.returncode == 1
    assert json.loads(cli.stderr)["error"] == "backup_invalid"
    assert cli.stdout == b""
    assert not destination.exists()
    assert not list(tmp_path.glob(".restored-restore-*"))
    assert store.snapshot() == before


@pytest.mark.parametrize("fault", ["crc", "size", "trailing-stream"])
def test_invalid_gzip_integrity_is_a_structured_failure(tmp_path: Path, fault: str) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic compression integrity", None, "gzip-home")
    before = store.snapshot()
    archive = tmp_path / "valid.tar.gz"
    create_backup(vault, archive)
    data = bytearray(archive.read_bytes())
    if fault == "trailing-stream":
        data.extend(b"\x1f\x8b\x08")  # A second, incomplete gzip member after a valid tar.
    else:
        data[-8 if fault == "crc" else -4] ^= 1
    damaged = tmp_path / "damaged.tar.gz"
    damaged.write_bytes(data)
    destination = tmp_path / "restored"
    with pytest.raises(WikiError) as error:
        restore_backup(damaged, destination)
    assert error.value.code == "backup_invalid"
    assert not destination.exists()
    assert not list(tmp_path.glob(".restored-restore-*"))
    assert store.snapshot() == before


def _repack_archive(
    archive: Path,
    target: Path,
    mode: Literal["w", "w:gz", "w:bz2", "w:xz"],
    manifest: bytes | None = None,
) -> None:
    with tarfile.open(archive, "r:gz") as source, tarfile.open(target, mode) as output:
        for member in source.getmembers():
            fileobj = source.extractfile(member)
            assert fileobj is not None
            data = (
                manifest
                if member.name == "manifest.json" and manifest is not None
                else fileobj.read()
            )
            copied = tarfile.TarInfo(member.name)
            copied.size = len(data)
            output.addfile(copied, io.BytesIO(data))


@pytest.mark.parametrize("manifest", [b"null", b"[]", b"1", b'"text"', b"\xff"])
def test_invalid_manifest_shape_or_encoding_is_rejected(tmp_path: Path, manifest: bytes) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic manifest integrity", None, "manifest-home")
    before = store.snapshot()
    archive = tmp_path / "valid.tar.gz"
    create_backup(vault, archive)
    damaged = tmp_path / "damaged.tar.gz"
    _repack_archive(archive, damaged, "w:gz", manifest)
    destination = tmp_path / "restored"
    with pytest.raises(WikiError) as error:
        restore_backup(damaged, destination)
    assert error.value.code == "backup_invalid"
    assert not destination.exists()
    assert not list(tmp_path.glob(".restored-restore-*"))
    assert store.snapshot() == before


@pytest.mark.parametrize("mode", ["w", "w:bz2", "w:xz"])
def test_restore_preserves_supported_tar_compression_formats(
    tmp_path: Path, mode: Literal["w", "w:bz2", "w:xz"]
) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    created = store.save_page("home", "# Synthetic compatible backup", None, "compatible-home")
    revision = store.snapshot()["revision"]
    archive = tmp_path / "valid.tar.gz"
    create_backup(vault, archive)
    compatible = tmp_path / "compatible.tar"
    _repack_archive(archive, compatible, mode)
    destination = tmp_path / "restored"
    assert restore_backup(compatible, destination)["revision"] == revision
    restored = WikiStore(destination)
    assert restored.save_page(
        "home", "# Synthetic compatible backup", None, "compatible-home"
    ) == created


@pytest.mark.parametrize("ledger", [".wiki-indexes.sqlite3", ".wiki-delivery.sqlite3"])
@pytest.mark.parametrize("damage", ["header", "btree"])
def test_corrupt_source_ledger_has_structured_error_and_no_archive(
    tmp_path: Path, ledger: str, damage: str
) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic source integrity", None, "source-home")
    before = store.snapshot()
    damaged = vault / ledger
    if damage == "btree":
        with sqlite3.connect(damaged) as db:
            db.execute("CREATE TABLE synthetic (value TEXT)")
        content = bytearray(damaged.read_bytes())
        content[100] = 0  # Invalid root b-tree page type, with valid SQLite header.
        original = bytes(content)
    else:
        original = b"not a SQLite database"
    damaged.write_bytes(original)
    archive = tmp_path / "backup.tar.gz"
    with pytest.raises(WikiError) as error:
        create_backup(vault, archive)
    assert error.value.code == "invalid_vault"
    assert store.snapshot() == before
    assert damaged.read_bytes() == original
    assert {item.name for item in tmp_path.iterdir()} == {"vault"}


    cli = subprocess.run(
        [sys.executable, "-m", "second_brain.wiki.backup", "create",
         "--vault", str(vault), "--archive", str(archive)],
        env={"PATH": os.environ["PATH"],
             "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
        capture_output=True, check=False,
    )
    assert cli.returncode == 1
    assert json.loads(cli.stderr) == {
        "error": "invalid_vault", "message": "Managed SQLite metadata is invalid."
    }
    assert cli.stdout == b""
    assert store.snapshot() == before
    assert damaged.read_bytes() == original
    assert {item.name for item in tmp_path.iterdir()} == {"vault"}


@pytest.mark.parametrize("code", [sqlite3.SQLITE_BUSY, sqlite3.SQLITE_FULL, sqlite3.SQLITE_IOERR])
def test_sqlite_storage_failure_is_not_reported_as_corruption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, code: int
) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic SQLite storage", None, "sqlite-storage")
    before = store.snapshot()
    ledger = vault / ".wiki-indexes.sqlite3"
    ledger.write_bytes(b"placeholder")

    def unavailable(*args: object, **kwargs: object) -> None:
        error = sqlite3.OperationalError("synthetic SQLite storage failure")
        error.sqlite_errorcode = code
        raise error

    monkeypatch.setattr(sqlite3, "connect", unavailable)
    with pytest.raises(WikiError) as error:
        create_backup(vault, tmp_path / "backup.tar.gz")
    assert error.value.code == "storage_unavailable"
    assert store.snapshot() == before
    assert ledger.read_bytes() == b"placeholder"
    assert {item.name for item in tmp_path.iterdir()} == {"vault"}


def test_damaged_bzip2_has_structured_error_and_no_restore(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    store.save_page("home", "# Synthetic bzip2 integrity", None, "bzip-home")
    before = store.snapshot()
    archive = tmp_path / "backup.tar.gz"
    create_backup(vault, archive)
    damaged = tmp_path / "damaged.tar.bz2"
    _repack_archive(archive, damaged, "w:bz2")
    data = bytearray(damaged.read_bytes())
    data[-8] ^= 1  # Corrupt the native bzip2 trailer, beyond tar's logical EOF.
    damaged.write_bytes(data)
    destination = tmp_path / "restored"
    with pytest.raises(WikiError) as error:
        restore_backup(damaged, destination)
    assert error.value.code == "backup_invalid"
    assert store.snapshot() == before
    expected = {vault.name, archive.name, damaged.name}
    assert {item.name for item in tmp_path.iterdir()} == expected
    cli = subprocess.run(
        [sys.executable, "-m", "second_brain.wiki.backup", "restore",
         "--archive", str(damaged), "--vault", str(destination)],
        env={"PATH": os.environ["PATH"],
             "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
        capture_output=True, check=False,
    )
    assert cli.returncode == 1
    assert json.loads(cli.stderr)["error"] == "backup_invalid"
    assert cli.stdout == b""
    assert store.snapshot() == before
    assert {item.name for item in tmp_path.iterdir()} == expected


@pytest.mark.parametrize("operation", ["create", "restore"])
def test_storage_errors_remain_distinct_from_corruption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
    operation: str,
) -> None:
    vault = tmp_path / "vault"
    WikiStore(vault).save_page("home", "# Synthetic storage boundary", None, "storage-home")
    archive = tmp_path / "backup.tar.gz"
    destination = tmp_path / "restored"
    if operation == "restore":
        create_backup(vault, archive)

    def unavailable(*args: object, **kwargs: object) -> None:
        raise OSError(errno.EIO, "synthetic storage failure")

    if operation == "create":
        (vault / ".wiki-indexes.sqlite3").write_bytes(b"placeholder")
        monkeypatch.setattr(sqlite3, "connect", unavailable)
    else:
        monkeypatch.setattr(tarfile, "open", unavailable)
    assert backup.main([
        operation, "--vault", str(vault if operation == "create" else destination),
        "--archive", str(archive),
    ]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert json.loads(captured.err)["error"] == "storage_unavailable"
    assert not destination.exists()
    assert not list(tmp_path.glob(".*-backup-*"))
    assert not list(tmp_path.glob(".*-restore-*"))
