"""Create and restore a portable managed-wiki backup archive.

The content authority is captured as a Git bundle. Known local SQLite ledgers are
copied through SQLite's online backup API before the bundle is created, so any
managed revisions they reference are reachable from the later captured head.
Provider-owned Neo4j/Qdrant data is derived and deliberately not included.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from second_brain.wiki.exporter import _publish
from second_brain.wiki.store import REF, WikiError, WikiStore

ARCHIVE_VERSION = 1
SQLITE_FILES = (".wiki-indexes.sqlite3", ".wiki-delivery.sqlite3")
PLAIN_FILES = (".second-brain-demo.json",)
ALLOWED_MEMBERS = {
    "manifest.json",
    "content.bundle",
    *(f"metadata/{name}" for name in SQLITE_FILES + PLAIN_FILES),
}


def _error(code: str, message: str) -> WikiError:
    return WikiError(code, message)


def _absolute(path: Path) -> Path:
    return Path(os.path.abspath(path))  # noqa: PTH100 - resolve would hide symlinks.


def _reject_symlink_components(path: Path, code: str) -> None:
    for component in (path, *path.parents):
        if component.is_symlink():
            raise _error(code, "Backup paths must not contain symbolic links.")


def _run_git(repo: Path, *args: str) -> bytes:
    result = subprocess.run(
        ["git", "--git-dir", str(repo), *args],
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise _error("backup_invalid", "Git backup verification failed.")
    return result.stdout


def _hash(path: Path) -> dict[str, int | str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
    return {"sha256": digest.hexdigest(), "bytes": size}


def _copy_sqlite(source: Path, destination: Path) -> None:
    source_uri = f"file:{source.as_posix()}?mode=ro"
    with (
        sqlite3.connect(source_uri, uri=True, timeout=10) as current,
        sqlite3.connect(destination) as copied,
    ):
        current.backup(copied)
        if copied.execute("PRAGMA integrity_check").fetchone() != ("ok",):
            raise _error("invalid_vault", "Managed SQLite metadata is invalid.")


def _source(vault: Path, archive: Path) -> tuple[Path, Path]:
    source = _absolute(vault)
    target = _absolute(archive)
    _reject_symlink_components(source, "invalid_vault")
    _reject_symlink_components(target, "invalid_archive")
    repo = source / ".wiki.git"
    if not source.is_dir() or repo.is_symlink() or not repo.is_dir():
        raise _error("invalid_vault", "Choose an existing managed wiki directory.")
    if target == source or target.is_relative_to(source) or source.is_relative_to(target):
        raise _error("invalid_archive", "The archive must not overlap the managed vault.")
    if not target.parent.is_dir() or target.exists():
        raise _error("invalid_archive", "Choose a new archive in an existing directory.")
    return source, target


def create_backup(vault: Path | str, archive: Path | str) -> dict[str, Any]:
    """Capture local authority and known ledgers without exporting provider data."""
    source, target = _source(Path(vault), Path(archive))
    prepared_root = Path(tempfile.mkdtemp(prefix=f".{target.name}-backup-", dir=target.parent))
    try:
        payload = prepared_root / "payload"
        metadata = payload / "metadata"
        metadata.mkdir(parents=True)
        captured: list[str] = []
        for name in SQLITE_FILES:
            item = source / name
            if item.is_symlink():
                raise _error("invalid_vault", "Managed metadata must not be a symbolic link.")
            if item.exists():
                if not item.is_file():
                    raise _error("invalid_vault", "Managed metadata must be a regular file.")
                _copy_sqlite(item, metadata / name)
                captured.append(f"metadata/{name}")
        for name in PLAIN_FILES:
            item = source / name
            if item.is_symlink():
                raise _error("invalid_vault", "Managed metadata must not be a symbolic link.")
            if item.exists():
                if not item.is_file():
                    raise _error("invalid_vault", "Managed metadata must be a regular file.")
                shutil.copyfile(item, metadata / name)
                captured.append(f"metadata/{name}")

        store = WikiStore(source)
        revision = store._head()
        if revision:
            bundle = payload / "content.bundle"
            _run_git(store.repo, "bundle", "create", str(bundle), REF)
            heads = subprocess.run(
                ["git", "bundle", "list-heads", str(bundle)],
                capture_output=True,
                check=False,
                text=True,
            )
            if heads.returncode or f"{revision} {REF}" not in heads.stdout.splitlines():
                raise _error("backup_changed", "The wiki changed while its backup was captured.")
            captured.append("content.bundle")
            page_count = len(store._pages(revision))
        else:
            page_count = 0
            if store._head():
                raise _error("backup_changed", "The wiki changed while its backup was captured.")

        files = {name: _hash(payload / name) for name in sorted(captured)}
        manifest = {
            "archive_version": ARCHIVE_VERSION,
            "created_at": datetime.now(UTC).isoformat(),
            "revision": revision or None,
            "page_count": page_count,
            "files": files,
            "provider_data_included": False,
        }
        (payload / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        prepared_archive = prepared_root / target.name
        with tarfile.open(prepared_archive, "w:gz") as output:
            for name in ["manifest.json", *sorted(captured)]:
                output.add(payload / name, arcname=name, recursive=False)
        _publish(prepared_archive, target)
        return {
            "operation": "backup",
            "archive": str(target),
            "revision": revision or None,
            "page_count": page_count,
            "provider_data_included": False,
        }
    finally:
        shutil.rmtree(prepared_root, ignore_errors=True)


def _read_archive(archive: Path, destination: Path) -> tuple[dict[str, Any], Path]:
    extracted = destination / "archive"
    extracted.mkdir()
    with tarfile.open(archive, "r:*") as source:
        members = source.getmembers()
        names = [member.name for member in members]
        if len(names) != len(set(names)) or any(
            not member.isfile() or member.name not in ALLOWED_MEMBERS for member in members
        ):
            raise _error("backup_invalid", "The archive contains unsupported entries.")
        if "manifest.json" not in names:
            raise _error("backup_invalid", "The archive manifest is missing.")
        for member in members:
            fileobj = source.extractfile(member)
            if fileobj is None:
                raise _error("backup_invalid", "The archive contains an unreadable entry.")
            target = extracted / member.name
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("wb") as output:
                shutil.copyfileobj(fileobj, output)
    try:
        manifest = json.loads((extracted / "manifest.json").read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise _error("backup_invalid", "The archive manifest is invalid.") from exc
    if manifest.get("archive_version") != ARCHIVE_VERSION or not isinstance(
        manifest.get("files"), dict
    ):
        raise _error("backup_invalid", "The archive version or file list is invalid.")
    if type(manifest.get("page_count")) is not int or manifest["page_count"] < 0:
        raise _error("backup_invalid", "The archive page count is invalid.")
    if manifest.get("provider_data_included") is not False:
        raise _error("backup_invalid", "The archive provider-data boundary is invalid.")
    expected = set(manifest["files"])
    if expected != set(names) - {"manifest.json"}:
        raise _error("backup_invalid", "The archive file list does not match its manifest.")
    for name, evidence in manifest["files"].items():
        if name not in ALLOWED_MEMBERS or not isinstance(evidence, dict):
            raise _error("backup_invalid", "The archive file evidence is invalid.")
        observed = _hash(extracted / name)
        if observed != evidence:
            raise _error("backup_invalid", "An archive checksum does not match.")
    revision = manifest.get("revision")
    if (revision is None) != ("content.bundle" not in expected) or (
        revision is not None
        and (
            not isinstance(revision, str)
            or len(revision) != 40
            or any(character not in "0123456789abcdef" for character in revision)
        )
    ):
        raise _error("backup_invalid", "The archive content revision is invalid.")
    return manifest, extracted


def _restore_target(vault: Path, archive: Path) -> Path:
    target = _absolute(vault)
    _reject_symlink_components(target, "invalid_destination")
    if target.exists() or not target.parent.is_dir():
        raise _error("invalid_destination", "Restore into a new directory with an existing parent.")
    if target == archive or target.is_relative_to(archive) or archive.is_relative_to(target):
        raise _error("invalid_destination", "The restored vault must not overlap the archive.")
    return target


def restore_backup(archive: Path | str, vault: Path | str) -> dict[str, Any]:
    """Verify a portable archive and publish a new restored vault atomically."""
    source = _absolute(Path(archive))
    _reject_symlink_components(source, "invalid_archive")
    if not source.is_file():
        raise _error("invalid_archive", "Choose an existing backup archive.")
    target = _restore_target(Path(vault), source)
    prepared_root = Path(tempfile.mkdtemp(prefix=f".{target.name}-restore-", dir=target.parent))
    prepared = prepared_root / "vault"
    prepared.mkdir()
    try:
        try:
            manifest, extracted = _read_archive(source, prepared_root)
        except tarfile.TarError as exc:
            raise _error("backup_invalid", "The backup archive is invalid.") from exc
        repo = prepared / ".wiki.git"
        subprocess.run(
            ["git", "init", "--bare", "--quiet", "--initial-branch=wiki", str(repo)],
            check=True,
            capture_output=True,
        )
        if manifest["revision"]:
            _run_git(
                repo,
                "fetch",
                "--quiet",
                str(extracted / "content.bundle"),
                f"{REF}:{REF}",
            )
            _run_git(repo, "fsck", "--full")
        for name in SQLITE_FILES + PLAIN_FILES:
            item = extracted / "metadata" / name
            if item.exists():
                shutil.copyfile(item, prepared / name)
        restored = WikiStore(prepared)
        snapshot = restored.snapshot()
        if snapshot["revision"] != manifest["revision"] or len(snapshot["pages"]) != manifest[
            "page_count"
        ]:
            raise _error("backup_invalid", "The restored snapshot does not match the manifest.")
        for name in SQLITE_FILES:
            item = prepared / name
            if item.exists():
                with sqlite3.connect(f"file:{item.as_posix()}?mode=ro", uri=True) as db:
                    if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                        raise _error("backup_invalid", "Restored SQLite metadata is invalid.")
        _publish(prepared, target)
        return {
            "operation": "restore",
            "vault": str(target),
            "revision": manifest["revision"],
            "page_count": manifest["page_count"],
            "provider_data_included": False,
        }
    except subprocess.CalledProcessError as exc:
        raise _error("backup_invalid", "The archive Git data is invalid.") from exc
    finally:
        shutil.rmtree(prepared_root, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    create = commands.add_parser("create", help="Create a new portable backup archive")
    create.add_argument("--vault", required=True)
    create.add_argument("--archive", required=True)
    restore = commands.add_parser("restore", help="Restore into a new managed vault directory")
    restore.add_argument("--archive", required=True)
    restore.add_argument("--vault", required=True)
    args = parser.parse_args(argv)
    try:
        result = (
            create_backup(args.vault, args.archive)
            if args.operation == "create"
            else restore_backup(args.archive, args.vault)
        )
    except (WikiError, OSError, tarfile.TarError) as exc:
        message = exc.message if isinstance(exc, WikiError) else "Backup storage is unavailable."
        code = exc.code if isinstance(exc, WikiError) else "storage_unavailable"
        print(json.dumps({"error": code, "message": message}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
