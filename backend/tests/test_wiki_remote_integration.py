"""Real synthetic Git histories for three-way inbound integration, without a worker."""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.delivery_runtime import configured_delivery
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore


def git(path: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args]).decode().strip()


def commit(source: Path, changes: dict[str, str | None]) -> str:
    for name, text in changes.items():
        path = source / name
        if text is None:
            path.unlink()
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
    git(source, "add", "-A")
    git(source, "commit", "-m", "synthetic external edit")
    git(source, "push", "origin", "HEAD:wiki")
    return git(source, "rev-parse", "HEAD")


@pytest.fixture
def history(tmp_path: Path) -> tuple[WikiStore, ManagedGitSync, Path, Path, str]:
    remote, source = tmp_path / "remote.git", tmp_path / "source"
    subprocess.run(["git", "init", "--bare", str(remote)], capture_output=True, check=True)
    subprocess.run(["git", "clone", str(remote), str(source)], capture_output=True, check=True)
    git(source, "config", "user.name", "Synthetic Test")
    git(source, "config", "user.email", "test@localhost")
    git(source, "checkout", "-b", "wiki")
    baseline = commit(
        source,
        {
            "notes/nested/Alpha.md": "# Alpha\n\nFirst paragraph.\n\nMiddle.\n\nLast paragraph.\n",
            "notes/Beta.md": "# Beta\n\nOriginal.\n",
            "README.md": "Unrelated Markdown outside the wiki.\n",
            "notes/asset.txt": "Unrelated asset.\n",
        },
    )
    store = WikiStore(tmp_path / "vault")
    sync = ManagedGitSync(store, str(remote), "wiki", "notes")
    sync.pull(None, baseline, "initial-pull")
    return store, sync, remote, source, baseline


def edit(store: WikiStore, page_id: str, text: str, request: str = "local-edit") -> None:
    page = store.get_page(page_id)
    store.save_page(page_id, text, page["revision"] if page else None, request)


def markdown(store: WikiStore, page_id: str) -> str | None:
    page = store.get_page(page_id)
    return page["markdown"] if page else None


def test_independent_changes_integrate_and_push_preserving_paths(history: Any) -> None:
    store, sync, remote, source, baseline = history
    edit(store, "Beta", "# Beta\nLocal change.\n")
    incoming = commit(source, {"notes/nested/Alpha.md": "# Alpha\nExternal change.\n"})
    result = sync.integrate(store._head(), baseline, incoming, "integrate")
    assert markdown(store, "Beta") == "# Beta\nLocal change.\n"
    assert markdown(store, "Alpha") == "# Alpha\nExternal change.\n"
    assert result["last_verified_remote_revision"] == incoming
    published = sync.push(store._head(), incoming, "publish")["published_revision"]
    assert git(remote, "show", published + ":notes/nested/Alpha.md") == "# Alpha\nExternal change."
    assert git(remote, "show", published + ":notes/Beta.md") == "# Beta\nLocal change."
    assert "notes/Alpha.md" not in git(remote, "ls-tree", "-r", "--name-only", published)
    assert git(remote, "show", published + ":README.md") == "Unrelated Markdown outside the wiki."
    assert git(remote, "show", published + ":notes/asset.txt") == "Unrelated asset."
    assert baseline in git(remote, "rev-list", published).splitlines()
    git(store.repo, "fsck", "--full")


def test_disjoint_lines_in_same_page_merge(history: Any) -> None:
    store, sync, _, source, baseline = history
    original = markdown(store, "Alpha")
    assert original is not None
    edit(store, "Alpha", original.replace("First paragraph.", "Local paragraph."))
    incoming = commit(
        source, {"notes/nested/Alpha.md": original.replace("Last paragraph.", "Remote paragraph.")}
    )
    sync.integrate(store._head(), baseline, incoming, "merge-lines")
    assert markdown(store, "Alpha") == original.replace(
        "First paragraph.", "Local paragraph."
    ).replace("Last paragraph.", "Remote paragraph.")


@pytest.mark.parametrize("case", ["overlap", "add-add", "local-delete", "remote-delete"])
def test_conflicts_leave_both_histories_unchanged(history: Any, case: str) -> None:
    store, sync, remote, source, baseline = history
    path, page_id = "notes/nested/Alpha.md", "Alpha"
    if case == "add-add":
        path, page_id = "notes/Gamma.md", "Gamma"
    if case == "local-delete":
        store.delete_page(page_id, store.get_page(page_id)["revision"], "delete")
    else:
        edit(store, page_id, "# Local competing content\n")
    incoming = commit(source, {path: None if case == "remote-delete" else "# Remote content\n"})
    local_head = store._head()
    with pytest.raises(WikiError) as caught:
        sync.integrate(local_head, baseline, incoming, "conflict")
    assert caught.value.code == "remote_conflict"
    assert store._head() == local_head
    assert git(remote, "rev-parse", "wiki") == incoming
    assert (
        not store._git("ls-tree", "-r", "--name-only", local_head).decode().find("MERGE_HEAD") >= 0
    )


def test_remote_delete_and_local_add_are_integrated(history: Any) -> None:
    store, sync, _, source, baseline = history
    edit(store, "Gamma", "# Gamma\nNew local article.\n")
    incoming = commit(source, {"notes/Beta.md": None})
    sync.integrate(store._head(), baseline, incoming, "delete-and-add")
    assert markdown(store, "Beta") is None
    assert markdown(store, "Gamma") == "# Gamma\nNew local article.\n"


def test_replay_after_local_edit_and_offline_remote(history: Any, monkeypatch: Any) -> None:
    store, sync, _, source, baseline = history
    incoming = commit(source, {"notes/Beta.md": "# Beta\nRemote.\n"})
    before = store._head()
    first = sync.integrate(before, baseline, incoming, "stable")
    edit(store, "Beta", "# Beta\nLater local edit.\n")
    later = store._head()
    restarted = ManagedGitSync(store, sync.remote, "wiki", "notes")
    monkeypatch.setattr(restarted, "_fetch", lambda: pytest.fail("Replay must not fetch"))
    assert restarted.integrate(before, baseline, incoming, "stable") == first
    assert store._head() == later
    with pytest.raises(WikiError) as caught:
        restarted.integrate(later, baseline, incoming, "stable")
    assert caught.value.code == "request_id_reused"


def test_prepared_merge_survives_import_interruption(history: Any, monkeypatch: Any) -> None:
    store, sync, _, source, baseline = history
    edit(store, "Alpha", "# Alpha\nLocal.\n")
    incoming = commit(source, {"notes/Beta.md": "# Beta\nRemote.\n"})
    before = store._head()
    with monkeypatch.context() as patch:

        def unavailable(*args: Any, **kwargs: Any) -> Any:
            raise WikiError("storage_unavailable", "Synthetic interruption")

        patch.setattr(sync, "_import_frozen", unavailable)
        with pytest.raises(WikiError):
            sync.integrate(before, baseline, incoming, "retry")
    restarted = ManagedGitSync(store, sync.remote, "wiki", "notes")
    restarted.integrate(before, baseline, incoming, "retry")
    assert markdown(store, "Alpha") == "# Alpha\nLocal.\n"
    assert markdown(store, "Beta") == "# Beta\nRemote.\n"


def test_local_write_during_preparation_is_not_overwritten(history: Any, monkeypatch: Any) -> None:
    store, sync, _, source, baseline = history
    incoming = commit(source, {"notes/Beta.md": "# Beta\nRemote.\n"})
    before, original = store._head(), sync._import_frozen

    def intervening(*args: Any, **kwargs: Any) -> Any:
        edit(store, "Alpha", "# Alpha\nConcurrent local write.\n")
        return original(*args, **kwargs)

    monkeypatch.setattr(sync, "_import_frozen", intervening)
    with pytest.raises(WikiError) as caught:
        sync.integrate(before, baseline, incoming, "local-race")
    assert caught.value.code == "revision_conflict"
    assert "Concurrent local write" in (markdown(store, "Alpha") or "")
    assert markdown(store, "Beta") == "# Beta\n\nOriginal.\n"


def test_moved_or_rewound_remote_is_refused(history: Any) -> None:
    store, sync, remote, source, baseline = history
    incoming = commit(source, {"notes/Beta.md": "# Beta\nRemote.\n"})
    before = store._head()
    with pytest.raises(WikiError):
        sync.integrate(before, baseline, baseline, "stale-observation")
    git(remote, "update-ref", "refs/heads/wiki", baseline)
    with pytest.raises(WikiError) as caught:
        sync.integrate(before, incoming, baseline, "rewind")
    assert caught.value.code == "remote_conflict"
    assert store._head() == before


def test_whole_wiki_deletion_requires_review(history: Any) -> None:
    store, sync, _, source, baseline = history
    incoming = commit(source, {"notes/Beta.md": None, "notes/nested/Alpha.md": None})
    before = store._head()
    with pytest.raises(WikiError) as caught:
        sync.integrate(before, baseline, incoming, "empty-remote")
    assert caught.value.code == "remote_conflict"
    assert store._head() == before


def configure(sync: ManagedGitSync, monkeypatch: Any) -> None:
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_SYNC", "1")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_REMOTE", sync.remote)
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_BRANCH", "wiki")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_PREFIX", "notes")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_MODE", "sync")


def test_runtime_bootstraps_before_serving_and_survives_restart(
    history: Any, tmp_path: Path, monkeypatch: Any
) -> None:
    _, sync, remote, source, _ = history
    configure(sync, monkeypatch)
    store = WikiStore(tmp_path / "fresh-instance")
    delivery = configured_delivery(store, IndexCoordinator(store))
    assert markdown(store, "Beta") == "# Beta\n\nOriginal.\n"
    assert delivery.run_once()["remote"]["state"] == "current"
    git(source, "pull", "--no-rebase", "origin", "wiki")
    incoming = commit(source, {"notes/Beta.md": "# Beta\nExternal after startup.\n"})
    edit(store, "Alpha", "# Alpha\nLocal after startup.\n")
    restarted = configured_delivery(store, IndexCoordinator(store))
    assert restarted.run_once()["remote"]["state"] == "current"
    published = git(remote, "rev-parse", "wiki")
    assert incoming in git(remote, "rev-list", published).splitlines()
    assert markdown(store, "Beta") == "# Beta\nExternal after startup.\n"
    assert (
        git(remote, "show", published + ":notes/nested/Alpha.md") == "# Alpha\nLocal after startup."
    )
    assert "External after startup" in str(store.search("External"))
    assert restarted.run_once()["remote"]["state"] == "current"
    assert git(remote, "rev-parse", "wiki") == published


def test_runtime_rejects_unrelated_local_wiki(history: Any, monkeypatch: Any) -> None:
    store, sync, remote, _, baseline = history
    configure(sync, monkeypatch)
    edit(store, "Beta", "# Beta\nUnrelated unbound local changes.\n")
    local = store._head()
    with pytest.raises(WikiError) as caught:
        configured_delivery(store, IndexCoordinator(store))
    assert caught.value.code == "remote_bootstrap_conflict"
    assert store._head() == local
    assert git(remote, "rev-parse", "wiki") == baseline


def test_runtime_inbound_lost_reply_replays_frozen_payload(history: Any, monkeypatch: Any) -> None:
    store, sync, _, source, baseline = history
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=baseline, synchronize=True
    )
    edit(store, "Alpha", "# Alpha\nLocal.\n")
    commit(source, {"notes/Beta.md": "# Beta\nExternal.\n"})
    integrate = sync.integrate

    def lose_reply(*args: Any, **kwargs: Any) -> Any:
        integrate(*args, **kwargs)
        raise WikiError("remote_unavailable", "Synthetic lost inbound reply")

    with monkeypatch.context() as patch:
        patch.setattr(sync, "integrate", lose_reply)
        assert delivery.run_once()["remote"]["state"] == "error"
    assert markdown(store, "Beta") == "# Beta\nExternal.\n"
    edit(store, "Gamma", "# Gamma\nLater local work.\n", "later-work")
    restarted = DeliveryCoordinator(store, IndexCoordinator(store), sync, synchronize=True)
    assert restarted.run_once()["remote"]["state"] == "current"
    assert markdown(store, "Gamma") == "# Gamma\nLater local work.\n"
    assert markdown(store, "Alpha") == "# Alpha\nLocal.\n"


def test_runtime_conflict_blocks_push_but_keeps_local_search(history: Any) -> None:
    store, sync, remote, source, baseline = history
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=baseline, synchronize=True
    )
    edit(store, "Alpha", "# Alpha\nLocal conflict.\n")
    incoming = commit(source, {"notes/nested/Alpha.md": "# Alpha\nRemote conflict.\n"})
    local = store._head()
    for _ in range(2):
        assert delivery.run_once()["remote"]["state"] == "conflict"
        assert store._head() == local
        assert git(remote, "rev-parse", "wiki") == incoming
    assert markdown(store, "Alpha") == "# Alpha\nLocal conflict.\n"
    edit(store, "Alpha", "# Alpha\nExplicitly reviewed resolution.\n", "resolution")
    delivery.reconcile_remote(store._head(), incoming)
    assert delivery.run_once()["remote"]["state"] == "current"


def test_runtime_empty_remote_accepts_first_local_write(tmp_path: Path, monkeypatch: Any) -> None:
    remote = tmp_path / "empty.git"
    subprocess.run(["git", "init", "--bare", str(remote)], capture_output=True, check=True)
    store = WikiStore(tmp_path / "empty-vault")
    sync = ManagedGitSync(store, str(remote), "wiki", "notes")
    configure(sync, monkeypatch)
    delivery = configured_delivery(store, IndexCoordinator(store))
    assert store._head() == ""
    edit(store, "Alpha", "# Alpha\nFirst write.\n")
    assert delivery.run_once()["remote"]["state"] == "current"
    assert git(remote, "show", "wiki:notes/Alpha.md") == "# Alpha\nFirst write."


def test_runtime_remote_unavailable_then_restored(history: Any) -> None:
    store, sync, remote, _, baseline = history
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=baseline, synchronize=True
    )
    edit(store, "Beta", "# Beta\nSaved while disconnected.\n")
    local = store._head()
    offline = remote.with_name("offline.git")
    remote.rename(offline)
    try:
        assert delivery.run_once()["remote"]["state"] == "error"
        assert store._head() == local
        assert markdown(store, "Beta") == "# Beta\nSaved while disconnected.\n"
    finally:
        offline.rename(remote)
    restarted = DeliveryCoordinator(store, IndexCoordinator(store), sync, synchronize=True)
    assert restarted.run_once()["remote"]["state"] == "current"
    assert git(remote, "show", "wiki:notes/Beta.md") == "# Beta\nSaved while disconnected."


def test_runtime_remote_advances_during_receive_retries(history: Any, monkeypatch: Any) -> None:
    store, sync, _, source, baseline = history
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=baseline, synchronize=True
    )
    commit(source, {"notes/Beta.md": "# Beta\nFirst external edit.\n"})
    inspect = sync.inspect

    def advance_after_observation() -> Any:
        observed = inspect()
        commit(source, {"notes/Beta.md": "# Beta\nSecond external edit.\n"})
        return observed

    before = store._head()
    with monkeypatch.context() as patch:
        patch.setattr(sync, "inspect", advance_after_observation)
        assert delivery.run_once()["remote"]["state"] == "pending"
    assert store._head() == before
    assert delivery.run_once()["remote"]["state"] == "current"
    assert markdown(store, "Beta") == "# Beta\nSecond external edit.\n"


def test_runtime_lost_push_reply_then_external_descendant(history: Any, monkeypatch: Any) -> None:
    store, sync, remote, source, baseline = history
    delivery = DeliveryCoordinator(
        store, IndexCoordinator(store), sync, expected_remote_revision=baseline, synchronize=True
    )
    edit(store, "Alpha", "# Alpha\nLocal pending push.\n")
    push = sync._push

    def lost(*args: Any, **kwargs: Any) -> Any:
        push(*args, **kwargs)
        raise WikiError("remote_unavailable", "Synthetic lost push reply")

    with monkeypatch.context() as patch:
        patch.setattr(sync, "_push", lost)
        assert delivery.run_once()["remote"]["state"] == "error"
    published = git(remote, "rev-parse", "wiki")
    git(source, "pull", "--no-rebase", "origin", "wiki")
    incoming = commit(source, {"notes/Beta.md": "# Beta\nExternal descendant.\n"})
    edit(store, "Gamma", "# Gamma\nLater local work.\n", "later-local")
    restarted = DeliveryCoordinator(store, IndexCoordinator(store), sync, synchronize=True)
    assert restarted.run_once()["remote"]["state"] == "pending"
    assert restarted.run_once()["remote"]["state"] == "current"
    assert markdown(store, "Beta") == "# Beta\nExternal descendant.\n"
    final = git(remote, "rev-parse", "wiki")
    assert published in git(remote, "rev-list", final).splitlines()
    assert incoming in git(remote, "rev-list", final).splitlines()
    assert git(remote, "show", "wiki:notes/Gamma.md") == "# Gamma\nLater local work."
