"""GitSync tests with real temporary repos (bare remote + working clones).

Covers the failure mode that silently broke prod for months: a conflicted
sync leaving the repo in an in-progress state.
"""
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import git
import pytest
from git import Actor

from second_brain.core.config import settings
from second_brain.git_sync import GitSync

ACTOR = Actor("test", "test@test.local")


def _commit_and_push(repo: git.Repo, message: str) -> None:
    repo.git.add("-A")
    repo.index.commit(message, author=ACTOR, committer=ACTOR)
    repo.git.push("origin", "HEAD")


@pytest.fixture
def vault_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """Bare 'GitHub' remote + seeded second clone + the vault clone.

    Global/system git config is disabled so the tests behave like CI and
    containers (no committer identity available).
    """
    empty_config = tmp_path / "empty-gitconfig"
    empty_config.touch()
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(empty_config))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")

    remote = tmp_path / "remote.git"
    git.Repo.init(remote, bare=True)

    seed_path = tmp_path / "seed"
    seed = git.Repo.clone_from(str(remote), str(seed_path))
    (seed_path / "README.md").write_text("# Vault\n\noriginal line\n", encoding="utf-8")
    _commit_and_push(seed, "init")

    vault_path = tmp_path / "vault"
    vault = git.Repo.clone_from(str(remote), str(vault_path))

    monkeypatch.setattr(settings, "VAULT_PATH", str(vault_path))
    monkeypatch.setattr(settings, "VAULT_GITHUB_URL", str(remote))
    monkeypatch.setattr(settings, "VAULT_GITHUB_PAT", "")

    return SimpleNamespace(
        remote=remote, seed=seed, seed_path=seed_path, vault=vault, vault_path=vault_path
    )


def _is_stuck(repo: git.Repo) -> bool:
    git_dir = Path(repo.git_dir)
    return (
        (git_dir / "rebase-merge").exists()
        or (git_dir / "rebase-apply").exists()
        or (git_dir / "MERGE_HEAD").exists()
    )


def test_push_commits_local_changes(vault_env: Any) -> None:
    (vault_env.vault_path / "note.md").write_text("# Note\n", encoding="utf-8")
    GitSync().push("remember: test note")

    remote_head = git.Repo(vault_env.remote).head.commit
    assert str(remote_head.message).startswith("remember: test note")
    assert "note.md" in remote_head.tree


def test_pull_merges_diverged_remote_and_local(vault_env: Any) -> None:
    # Remote gets a new file from another instance
    (vault_env.seed_path / "from-remote.md").write_text("remote\n", encoding="utf-8")
    _commit_and_push(vault_env.seed, "remember: remote change")
    # Local has uncommitted work
    (vault_env.vault_path / "from-local.md").write_text("local\n", encoding="utf-8")

    GitSync().pull()

    assert (vault_env.vault_path / "from-remote.md").exists()
    assert (vault_env.vault_path / "from-local.md").exists()
    assert not _is_stuck(vault_env.vault)
    assert not vault_env.vault.is_dirty(untracked_files=True)


def test_pull_conflict_local_wins_and_push_succeeds(vault_env: Any) -> None:
    # Both sides change the same line
    (vault_env.seed_path / "README.md").write_text(
        "# Vault\n\nremote version\n", encoding="utf-8"
    )
    _commit_and_push(vault_env.seed, "remote edit")
    (vault_env.vault_path / "README.md").write_text(
        "# Vault\n\nlocal version\n", encoding="utf-8"
    )

    GitSync().pull()

    content = (vault_env.vault_path / "README.md").read_text(encoding="utf-8")
    assert "local version" in content  # -X ours: the writing instance wins
    assert not _is_stuck(vault_env.vault)

    GitSync().push("after conflict")
    remote_head = git.Repo(vault_env.remote).head.commit
    assert "local version" in remote_head.tree["README.md"].data_stream.read().decode()


def test_recovers_from_stuck_rebase(vault_env: Any) -> None:
    """Reproduces the prod failure: a conflicted rebase left in progress."""
    vault = vault_env.vault
    (vault_env.vault_path / "README.md").write_text(
        "# Vault\n\nlocal version\n", encoding="utf-8"
    )
    vault.git.add("-A")
    vault.index.commit("local edit", author=ACTOR, committer=ACTOR)

    (vault_env.seed_path / "README.md").write_text(
        "# Vault\n\nremote version\n", encoding="utf-8"
    )
    _commit_and_push(vault_env.seed, "remote edit")

    vault.git.fetch("origin")
    with pytest.raises(git.GitCommandError):
        vault.git.rebase(f"origin/{vault.active_branch.name}")
    assert _is_stuck(vault)  # this is the state prod sat in for months

    GitSync().pull()
    assert not _is_stuck(vault)

    # push delivers the recovered state (no new commit needed — the merge
    # created during pull is what gets pushed)
    GitSync().push("after recovery")
    assert not _is_stuck(vault)
    remote_head = git.Repo(vault_env.remote).head.commit
    readme = remote_head.tree["README.md"].data_stream.read().decode()
    assert "local version" in readme  # -X ours kept the writing instance's state
    assert remote_head.hexsha == vault.head.commit.hexsha  # fully synced
