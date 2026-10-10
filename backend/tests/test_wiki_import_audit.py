"""Migration acceptance checks against synthetic legacy-style Git history."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from second_brain.wiki.backup import create_backup, restore_backup
from second_brain.wiki.import_audit import audit_import
from second_brain.wiki.importer import import_vault
from second_brain.wiki.store import WikiError, WikiStore


def git(source: Path, *args: str) -> bytes:
    return subprocess.run(["git", "-C", str(source), *args], check=True, capture_output=True).stdout


def legacy_source(path: Path) -> tuple[Path, str]:
    path.mkdir()
    git(path, "init", "--quiet")
    git(path, "config", "user.name", "Synthetic Archivist")
    git(path, "config", "user.email", "archive@example.invalid")
    wiki = path / "1_knowledge" / "wiki"
    wiki.mkdir(parents=True)
    (wiki / "home.md").write_bytes(b"# Lantern archive\r\n\r\nSee [[sky]].\r\n")
    git(path, "add", "--all")
    git(path, "commit", "--quiet", "-m", "Create fictional archive")
    (wiki / "sky.md").write_text("# Fictional sky\n\nReturn to [[home]].\n", encoding="utf-8")
    (path / "outside.txt").write_text("Retained source history.\n", encoding="utf-8")
    git(path, "add", "--all")
    git(path, "commit", "--quiet", "-m", "Link fictional sky")
    return path, git(path, "rev-parse", "HEAD").decode().strip()


def test_audit_proves_bytes_ids_paths_and_retained_history(tmp_path: Path) -> None:
    source, source_revision = legacy_source(tmp_path / "legacy")
    source_head_before = git(source, "rev-parse", "HEAD")
    source_status_before = git(source, "status", "--porcelain=v1")
    store = WikiStore(tmp_path / "managed")
    imported = import_vault(
        store,
        source,
        prefix="1_knowledge/wiki",
        base_revision=None,
        request_id="migration-acceptance",
    )

    result = audit_import(
        store,
        source,
        prefix="1_knowledge/wiki",
        revision=imported["revision"],
    )

    assert result["status"] == "verified"
    assert result["source_revision"] == source_revision
    assert result["page_ids"] == ["home", "sky"]
    assert result["markdown_bytes"] == "exact"
    assert result["source_paths"] == "verified"
    assert result["source_history"] == "retained"
    assert len(result["content_sha256"]) == 64
    assert git(source, "rev-parse", "HEAD") == source_head_before
    assert git(source, "status", "--porcelain=v1") == source_status_before

    # A later managed edit does not invalidate evidence for the pinned import.
    page = store.get_page("sky")
    assert page
    store.save_page("sky", "# Managed edit\n", page["revision"], "managed-edit")
    later = audit_import(
        store,
        source,
        prefix="1_knowledge/wiki",
        revision=imported["revision"],
    )
    assert later["managed_revision"] == imported["revision"]
    assert later["current_revision"] == store._head()


def test_audit_refuses_changed_source_or_nonimport_revision(tmp_path: Path) -> None:
    source, _ = legacy_source(tmp_path / "legacy")
    store = WikiStore(tmp_path / "managed")
    imported = import_vault(
        store,
        source,
        prefix="1_knowledge/wiki",
        base_revision=None,
        request_id="migration-acceptance",
    )
    page = store.get_page("home")
    assert page
    store.save_page("home", "# Managed-only revision\n", page["revision"], "edit")
    edited_revision = store._head()
    with pytest.raises(WikiError, match="exact page snapshot"):
        audit_import(
            store,
            source,
            prefix="1_knowledge/wiki",
            revision=edited_revision,
        )

    wiki = source / "1_knowledge" / "wiki"
    (wiki / "home.md").write_text("# Advanced source\n", encoding="utf-8")
    git(source, "add", "--all")
    git(source, "commit", "--quiet", "-m", "Advance synthetic source")
    with pytest.raises(WikiError, match="exact page snapshot") as changed_source:
        audit_import(
            store,
            source,
            prefix="1_knowledge/wiki",
            revision=imported["revision"],
        )
    assert changed_source.value.code == "content_mismatch"


def test_audit_cli_reports_machine_readable_evidence(tmp_path: Path) -> None:
    source, _ = legacy_source(tmp_path / "legacy")
    store = WikiStore(tmp_path / "managed")
    imported = import_vault(
        store,
        source,
        prefix="1_knowledge/wiki",
        base_revision=None,
        request_id="migration-cli",
    )
    backend = Path(__file__).resolve().parents[1]
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": str(backend / "src")}
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "second_brain.wiki.import_audit",
            "--vault",
            str(store.path),
            "--source",
            str(source),
            "--prefix",
            "1_knowledge/wiki",
            "--revision",
            imported["revision"],
        ],
        cwd=backend,
        env=env,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    evidence = json.loads(result.stdout)
    assert evidence["status"] == "verified"
    assert evidence["pages"] == 2
    assert evidence["page_ids"] == ["home", "sky"]


def test_replacement_audit_and_non_destructive_rollback(tmp_path: Path) -> None:
    source, _ = legacy_source(tmp_path / "legacy")
    vault = tmp_path / "managed"
    store = WikiStore(vault)
    store.save_page("prior", "# Prior synthetic wiki\n", None, "prior")
    prior_revision = store._head()
    archive = tmp_path / "before-migration.tar.gz"
    backup = create_backup(vault, archive)
    assert backup["revision"] == prior_revision

    imported = import_vault(
        store,
        source,
        prefix="1_knowledge/wiki",
        base_revision=prior_revision,
        request_id="replacement-migration",
    )
    assert audit_import(
        store,
        source,
        prefix="1_knowledge/wiki",
        revision=imported["revision"],
    )["status"] == "verified"

    restored_path = tmp_path / "rolled-back"
    restored = restore_backup(archive, restored_path)
    assert restored["revision"] == prior_revision
    assert WikiStore(restored_path).get_page("prior") is not None
    assert WikiStore(restored_path).get_page("home") is None
    assert store._head() == imported["revision"]
