"""Real-Git export tests with synthetic content."""

# Pytest assertions, fixture signatures and injected fault helpers are intentional.
# The CLI subprocess uses this interpreter and only synthetic temporary paths.
# ruff: noqa: S101, D103, FBT001, SLF001, S603
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from second_brain.wiki import exporter
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
