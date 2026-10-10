"""Synthetic real-Git tests of the explicit remote boundary."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore


def git(path: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args]).decode().strip()


def setup(tmp_path: Path) -> tuple[WikiStore, Path, ManagedGitSync, str]:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    store = WikiStore(tmp_path / "vault")
    store.save_page("Alpha", "# Alpha\nSynthetic content", None, "create")
    return store, remote, ManagedGitSync(store, str(remote), "wiki", "notes"), store._head()


def advance(remote: Path, commit: str) -> str:
    tree = git(remote, "rev-parse", commit + "^{tree}")
    result = (
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
                commit,
            ],
            input=b"external edit\n",
            capture_output=True,
            check=True,
        )
        .stdout.decode()
        .strip()
    )
    git(remote, "update-ref", "refs/heads/wiki", result)
    return result


def test_snapshot_boundary_and_pull(tmp_path: Path) -> None:
    store, remote, sync, base = setup(tmp_path)
    result = sync.push(base, None, "publish")
    commit = result["published_revision"]
    assert git(remote, "ls-tree", "-r", "--name-only", commit) == "notes/Alpha.md"
    assert git(remote, "rev-list", "--count", commit) == "1"
    assert store._head() == base
    assert not git(sync.repo, "config", "--list").find(str(remote)) >= 0
    target = WikiStore(tmp_path / "target")
    reader = ManagedGitSync(target, str(remote), "wiki", "notes")
    pulled = reader.pull(None, commit, "read")
    assert target.get_page("Alpha") is not None
    assert reader.pull(None, commit, "read")["revision"] == pulled["revision"]
    with pytest.raises(WikiError, match="payload"):
        reader.pull(target._head(), commit, "read")


def test_lost_ack_restart_and_external_descendant(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, remote, sync, base = setup(tmp_path)
    original = sync._run

    def lost(*args: str, **kwargs: Any) -> bytes:
        output = original(*args, **kwargs)
        if args[0] == "push":
            raise WikiError("remote_unavailable", "lost reply")
        return output

    monkeypatch.setattr(sync, "_run", lost)
    with pytest.raises(WikiError, match="lost reply"):
        sync.push(base, None, "publish")
    published = git(remote, "rev-parse", "refs/heads/wiki")
    newer = advance(remote, published)
    restarted = ManagedGitSync(store, str(remote), "wiki", "notes")
    result = restarted.push(base, None, "publish")
    assert result["published_revision"] == published
    assert result["last_verified_remote_revision"] == newer
    with pytest.raises(WikiError, match="payload"):
        restarted.push(base, published, "publish")


def test_forward_conflict_and_changed_pull_head(tmp_path: Path) -> None:
    store, remote, sync, base = setup(tmp_path)
    published = sync.push(base, None, "one")["published_revision"]
    newer = advance(remote, published)
    with pytest.raises(WikiError, match="changed"):
        sync.push(base, published, "two")
    with pytest.raises(WikiError, match="changed"):
        sync.pull(base, published, "read")
    assert git(remote, "rev-parse", "wiki") == newer


def test_write_during_push_exports_frozen_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, remote, sync, base = setup(tmp_path)
    original = sync._run

    def write(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "push":
            page = store.get_page("Alpha")
            assert page is not None
            store.save_page("Alpha", "# Changed", page["revision"], "edit")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "_run", write)
    published = sync.push(base, None, "one")["published_revision"]
    assert git(remote, "show", published + ":notes/Alpha.md") == "# Alpha\nSynthetic content"
    assert store._head() != base


def test_failure_retains_prepared_snapshot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, remote, sync, base = setup(tmp_path)
    original = sync._run

    def fail(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "push":
            raise WikiError("remote_unavailable", "offline")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "_run", fail)
    with pytest.raises(WikiError, match="offline"):
        sync.push(base, None, "one")
    page = store.get_page("Alpha")
    assert page is not None
    store.save_page("Alpha", "# New local content", page["revision"], "change")
    restarted = ManagedGitSync(store, str(remote), "wiki", "notes")
    published = restarted.push(base, None, "one")["published_revision"]
    assert "Synthetic" in git(remote, "show", published + ":notes/Alpha.md")


@pytest.mark.parametrize(
    "remote",
    [
        "https://u:p@example.com/r",
        "https://u@example.com/r",
        "https://example.com/r?token=s",
        "ext::command",
        "-r",
    ],
)
def test_reject_credentials_and_helpers(tmp_path: Path, remote: str) -> None:
    with pytest.raises(WikiError):
        ManagedGitSync(WikiStore(tmp_path / "vault"), remote, "wiki")


def test_forward_race_normal_push_rejects(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, remote, sync, base = setup(tmp_path)
    old = sync.push(base, None, "initial")["published_revision"]
    original = sync._run
    moved: list[str] = []

    def race(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "push":
            moved.append(advance(remote, old))
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "_run", race)
    with pytest.raises(WikiError):
        sync.push(base, old, "raced")
    assert git(remote, "rev-parse", "wiki") == moved[0]


def test_deletion_and_recreation_conflict(tmp_path: Path) -> None:
    _, remote, sync, base = setup(tmp_path)
    old = sync.push(base, None, "initial")["published_revision"]
    git(remote, "update-ref", "-d", "refs/heads/wiki")
    with pytest.raises(WikiError, match="changed"):
        sync.push(base, old, "deleted")
    replacement = advance(remote, old)
    with pytest.raises(WikiError, match="changed"):
        sync.push(base, old, "recreated")
    assert git(remote, "rev-parse", "wiki") == replacement


def test_preserves_nonwiki_and_outside_prefix(tmp_path: Path) -> None:
    _, remote, sync, base = setup(tmp_path)
    old = sync.push(base, None, "initial")["published_revision"]
    checkout = tmp_path / "checkout"
    subprocess.run(
        ["git", "clone", "--branch", "wiki", str(remote), str(checkout)],
        check=True,
        capture_output=True,
    )
    (checkout / "README.md").write_text("Outside prefix")
    (checkout / "notes" / "asset.txt").write_text("Nonwiki asset")
    git(checkout, "add", ".")
    git(
        checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "Assets",
    )
    git(checkout, "push", "origin", "wiki")
    current = git(remote, "rev-parse", "wiki")
    published = sync.push(base, current, "preserve")["published_revision"]
    assert git(remote, "show", published + ":README.md") == "Outside prefix"
    assert git(remote, "show", published + ":notes/asset.txt") == "Nonwiki asset"
    assert git(remote, "merge-base", old, published) == old


def test_duplicate_remote_ids_refused(tmp_path: Path) -> None:
    _, remote, sync, base = setup(tmp_path)
    sync.push(base, None, "initial")
    checkout = tmp_path / "checkout"
    subprocess.run(
        ["git", "clone", "--branch", "wiki", str(remote), str(checkout)],
        check=True,
        capture_output=True,
    )
    (checkout / "notes" / "nested").mkdir()
    (checkout / "notes" / "nested" / "Alpha.md").write_text("Duplicate")
    git(checkout, "add", ".")
    git(
        checkout,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@localhost",
        "commit",
        "-m",
        "Duplicate",
    )
    git(checkout, "push", "origin", "wiki")
    current = git(remote, "rev-parse", "wiki")
    with pytest.raises(WikiError, match="Duplicate"):
        sync.push(base, current, "invalid")
    with pytest.raises(WikiError, match="Duplicate"):
        sync.pull(base, current, "read")


def test_pull_retry_after_remote_and_managed_edits(tmp_path: Path) -> None:
    _, remote, sync, base = setup(tmp_path)
    published = sync.push(base, None, "initial")["published_revision"]
    target = WikiStore(tmp_path / "target")
    reader = ManagedGitSync(target, str(remote), "wiki", "notes")
    imported = reader.pull(None, published, "read")["revision"]
    page = target.get_page("Alpha")
    assert page is not None
    target.save_page("Alpha", "# Subsequent edit", page["revision"], "edit")
    current = target._head()
    advance(remote, published)
    assert reader.pull(None, published, "read")["revision"] == imported
    assert target._head() == current


def test_separate_requests_retain_prepared_objects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _, _, sync, base = setup(tmp_path)
    original = sync._run

    def offline(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "push":
            raise WikiError("remote_unavailable", "offline")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "_run", offline)
    for request in ("first", "second"):
        with pytest.raises(WikiError):
            sync.push(base, None, request)
    refs = git(sync.repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/prepared")
    assert len(refs.splitlines()) == 2
    git(sync.repo, "reflog", "expire", "--expire=now", "--all")
    git(sync.repo, "gc", "--prune=now")
    for row in refs.splitlines():
        assert git(sync.repo, "cat-file", "-t", row.split()[1]) == "commit"


def test_confirmed_push_retry_does_not_require_live_remote(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store, remote, sync, base = setup(tmp_path)
    acknowledged = sync.push(base, None, "initial")
    assert acknowledged["content_revision"] == base
    assert acknowledged["request_id"] == "initial"
    page = store.get_page("Alpha")
    assert page is not None
    store.save_page("Alpha", "# Later edit", page["revision"], "edit")
    current = store._head()
    remote.rename(tmp_path / "unavailable.git")
    restarted = ManagedGitSync(store, str(remote), "wiki", "notes")

    def unavailable() -> str | None:
        raise AssertionError("confirmed acknowledgement must not require a fetch")

    monkeypatch.setattr(restarted, "_fetch", unavailable)
    assert restarted.push(base, None, "initial") == acknowledged
    assert store._head() == current


@pytest.mark.parametrize("move", ["delete", "rewind"])
def test_advertised_remote_guard_rejects_delete_or_rewind(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, move: str
) -> None:
    _, remote, sync, base = setup(tmp_path)
    first = sync.push(base, None, "first")["published_revision"]
    expected = sync.push(base, first, "second")["published_revision"]
    original = sync._run
    raced: list[bool] = []

    def race(*args: str, **kwargs: Any) -> bytes:
        if args[0] == "push":
            raced.append(True)
            if move == "delete":
                git(remote, "update-ref", "-d", "refs/heads/wiki")
            else:
                git(remote, "update-ref", "refs/heads/wiki", first)
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "_run", race)
    with pytest.raises(WikiError):
        sync.push(base, expected, "guarded")
    assert raced
    if move == "delete":
        assert git(remote, "for-each-ref", "--format=%(objectname)", "refs/heads/wiki") == ""
    else:
        assert git(remote, "rev-parse", "wiki") == first


def test_pre_push_guard_interpreter_path_with_spaces(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import sys

    _, remote, sync, base = setup(tmp_path)
    interpreter = tmp_path / "python path" / "python"
    interpreter.parent.mkdir()
    interpreter.symlink_to(sys.executable)
    monkeypatch.setattr(sys, "executable", str(interpreter))
    result = sync.push(base, None, "spaced-python")
    assert git(remote, "rev-parse", "wiki") == result["published_revision"]


def test_pull_request_ids_with_shared_prefix_are_distinct(tmp_path: Path) -> None:
    _, remote, sync, base = setup(tmp_path)
    published = sync.push(base, None, "initial")["published_revision"]
    target = WikiStore(tmp_path / "target")
    reader = ManagedGitSync(target, str(remote), "wiki", "notes")
    request_prefix = "x" * 64
    reader.pull(None, published, request_prefix + "first")
    with pytest.raises(WikiError, match="changed"):
        reader.pull(None, published, request_prefix + "second")
