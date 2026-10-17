"""Real-Git export tests with synthetic content."""

# Pytest assertions, fixture signatures and injected fault helpers are intentional.
# The CLI subprocess uses this interpreter and only synthetic temporary paths.
# ruff: noqa: S101, D103, FBT001, SLF001, S603
from __future__ import annotations

import errno
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from second_brain.wiki import exporter
from second_brain.wiki.backup import create_backup, restore_backup
from second_brain.wiki.store import WikiError, WikiStore


def _store(tmp_path: Path) -> tuple[WikiStore, str, bytes]:
    store = WikiStore(tmp_path / "vault")
    content = "---\r\ntitle: Café\r\n---\r\n# Café ☕\r\n[[other]]\r\n".encode()
    store.save_page("café", content.decode(), None, "first")
    gone = store.save_page("deleted", "# Gone", None, "gone")
    store.delete_page("deleted", gone["revision"], "delete")
    return store, str(store.snapshot()["revision"]), content


@pytest.mark.parametrize("existing", [False, True])
def test_current_markdown_only(tmp_path: Path, existing: bool) -> None:
    store, revision, content = _store(tmp_path)
    (store.path / "credentials").write_text("synthetic-secret")
    (store.path / "index.db").write_bytes(b"synthetic-index")
    target = tmp_path / "plain"
    if existing:
        target.mkdir()
    result = exporter.export_vault(store, target, base_revision=revision)
    assert result["revision"] == revision
    assert result["page_count"] == 1
    assert list(target.iterdir()) == [target / "café.md"]
    assert (target / "café.md").read_bytes() == content
    with pytest.raises(WikiError, match="new or empty"):
        exporter.export_vault(store, target, base_revision=revision)


def test_stale_and_empty(tmp_path: Path) -> None:
    store = WikiStore(tmp_path / "vault")
    target = tmp_path / "plain"
    with pytest.raises(WikiError, match="changed before export"):
        exporter.export_vault(store, target, base_revision="stale")
    assert not target.exists()
    assert exporter.export_vault(store, target, base_revision="")["revision"] is None
    assert list(target.iterdir()) == []


@pytest.mark.parametrize("kind", ["symlink", "ancestor_symlink", "nonempty", "file", "overlap"])
def test_unsafe_destinations(tmp_path: Path, kind: str) -> None:
    store, revision, _ = _store(tmp_path)
    target = tmp_path / "plain"
    if kind == "symlink":
        target.symlink_to(tmp_path / "missing", target_is_directory=True)
    elif kind == "ancestor_symlink":
        actual = tmp_path / "actual"
        actual.mkdir()
        target.symlink_to(actual, target_is_directory=True)
        target = target / "child"
    elif kind == "nonempty":
        target.mkdir()
        (target / "keep").write_text("synthetic-content")
    elif kind == "file":
        target.write_text("synthetic-content")
    else:
        target = store.path / "export"
    with pytest.raises(WikiError):
        exporter.export_vault(store, target, base_revision=revision)
    assert not list(tmp_path.glob(".*-export-*"))


def test_captured_revision_during_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, revision, content = _store(tmp_path)
    original = Path.write_bytes
    changed = False

    def write(path: Path, data: bytes) -> int:
        nonlocal changed
        if not changed:
            changed = True
            store.save_page("new", "# New", None, "concurrent")
        return original(path, data)

    monkeypatch.setattr(Path, "write_bytes", write)
    target = tmp_path / "plain"
    result = exporter.export_vault(store, target, base_revision=revision)
    assert result["revision"] == revision
    assert store.snapshot()["revision"] != revision
    assert list(target.iterdir()) == [target / "café.md"]
    assert (target / "café.md").read_bytes() == content


@pytest.mark.parametrize("existing", [False, True])
def test_preparation_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    existing: bool,
) -> None:
    store, revision, _ = _store(tmp_path)
    target = tmp_path / "plain"
    if existing:
        target.mkdir()

    def fail(_path: Path, _data: bytes) -> int:
        message = "synthetic failure"
        raise OSError(message)

    monkeypatch.setattr(Path, "write_bytes", fail)
    with pytest.raises(OSError, match="synthetic"):
        exporter.export_vault(store, target, base_revision=revision)
    assert target.exists() == existing
    assert not list(tmp_path.glob(".*-export-*"))


@pytest.mark.parametrize("symlink", [False, True])
def test_publication_race(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    symlink: bool,
) -> None:
    store, revision, _ = _store(tmp_path)
    target = tmp_path / "plain"
    original = exporter._publish

    def competing_publish(prepared: Path, destination: Path) -> None:
        if symlink:
            destination.symlink_to(tmp_path / "missing", target_is_directory=True)
        else:
            destination.mkdir()
            (destination / "keep").write_text("synthetic competing output")
        original(prepared, destination)

    monkeypatch.setattr(exporter, "_publish", competing_publish)
    with pytest.raises(WikiError, match="changed during export"):
        exporter.export_vault(store, target, base_revision=revision)
    if symlink:
        assert target.is_symlink()
    else:
        assert list(target.iterdir()) == [target / "keep"]
        assert (target / "keep").read_text() == "synthetic competing output"
    assert not list(tmp_path.glob(".*-export-*"))


def test_publication_failure_restores_empty(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, revision, _ = _store(tmp_path)
    target = tmp_path / "plain"
    target.mkdir()

    def fail(_prepared: Path, _destination: Path) -> None:
        message = "synthetic rename failure"
        raise OSError(message)

    monkeypatch.setattr(exporter, "_publish", fail)
    with pytest.raises(OSError, match="synthetic"):
        exporter.export_vault(store, target, base_revision=revision)
    assert target.is_dir()
    assert list(target.iterdir()) == []
    assert not list(tmp_path.glob(".*-export-*"))


def test_cli(tmp_path: Path) -> None:
    store, revision, content = _store(tmp_path)
    target = tmp_path / "plain"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "second_brain.wiki.exporter",
            "--vault",
            str(store.path),
            "--destination",
            str(target),
            "--base-revision",
            revision,
        ],
        capture_output=True,
        check=False,
        cwd=Path(exporter.__file__).resolve().parents[2],
    )
    assert result.returncode == 0, result.stderr
    assert revision.encode() in result.stdout
    assert (target / "café.md").read_bytes() == content


@pytest.mark.parametrize("existing", [False, True])
def test_native_long_unicode_filename_refused_before_preparation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    existing: bool,
) -> None:
    page_id = "漢" * 85
    if os.pathconf(tmp_path, "PC_NAME_MAX") >= len(os.fsencode(f"{page_id}.md")):
        pytest.skip("The native filesystem supports this filename")
    store = WikiStore(tmp_path / "vault")
    store.save_page(page_id, "# Synthetic long ID\n", None, "long-id")
    before = store.snapshot()
    target = tmp_path / "plain"
    if existing:
        target.mkdir()
    inode = target.stat().st_ino if existing else None

    def no_preparation(*_args: object, **_kwargs: object) -> str:
        pytest.fail("filename refusal must happen before temporary output creation")

    with monkeypatch.context() as patch:
        patch.setattr(tempfile, "mkdtemp", no_preparation)
        with pytest.raises(WikiError) as error:
            exporter.export_vault(store, target, base_revision=str(before["revision"]))
    assert error.value.code == "export_filename_too_long"
    assert "backup" in str(error.value).lower()
    assert "restore" in str(error.value).lower()
    assert target.exists() == existing
    if existing:
        assert target.stat().st_ino == inode
        assert list(target.iterdir()) == []
    assert store.snapshot() == before
    assert not list(tmp_path.glob(".*-export-*"))

    archive = tmp_path / "backup.tar.gz"
    create_backup(store.path, archive)
    restored_path = tmp_path / "restored"
    restore_backup(archive, restored_path)
    assert WikiStore(restored_path).snapshot() == before


@pytest.mark.parametrize("page_id", ["a" * 160, "漢" * 84])
def test_filename_byte_boundary(tmp_path: Path, page_id: str) -> None:
    if os.pathconf(tmp_path, "PC_NAME_MAX") < len(os.fsencode(f"{page_id}.md")):
        pytest.skip("The native filesystem has a smaller filename limit")
    store = WikiStore(tmp_path / "vault")
    store.save_page(page_id, "# Synthetic boundary\n", None, "boundary")
    target = tmp_path / "plain"
    result = exporter.export_vault(store, target, base_revision=str(store.snapshot()["revision"]))
    assert result["page_count"] == 1
    assert (target / f"{page_id}.md").read_bytes() == b"# Synthetic boundary\n"


@pytest.mark.parametrize("limit", [-1, "unsupported", "unavailable", "missing"])
@pytest.mark.parametrize("too_long", [False, True])
def test_unknown_filename_limit_uses_native_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    limit: int | str,
    too_long: bool,
) -> None:
    store, revision, content = _store(tmp_path)
    target = tmp_path / "plain"
    target.mkdir()
    inode = target.stat().st_ino

    def pathconf(_path: Path, _name: str) -> int:
        if limit == "unsupported":
            raise ValueError("synthetic unsupported pathconf")
        if limit == "unavailable":
            raise OSError(errno.EINVAL, "synthetic unavailable pathconf")
        assert isinstance(limit, int)
        return limit

    if limit == "missing":
        monkeypatch.delattr(os, "pathconf")
    else:
        monkeypatch.setattr(os, "pathconf", pathconf)
    if too_long:

        def fail(_path: Path, _data: bytes) -> int:
            raise OSError(errno.ENAMETOOLONG, "synthetic native filename limit")

        monkeypatch.setattr(Path, "write_bytes", fail)
        with pytest.raises(WikiError) as error:
            exporter.export_vault(store, target, base_revision=revision)
        assert error.value.code == "export_filename_too_long"
        assert target.stat().st_ino == inode
        assert list(target.iterdir()) == []
    else:
        exporter.export_vault(store, target, base_revision=revision)
        assert (target / "café.md").read_bytes() == content
    assert not list(tmp_path.glob(".*-export-*"))
