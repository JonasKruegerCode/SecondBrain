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
from second_brain.git_sync import GitSync, _without_http_credentials

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
    monkeypatch.setattr(settings, "VAULT_GIT_URL", "")
    monkeypatch.setattr(settings, "VAULT_GIT_BRANCH", "")
    monkeypatch.setattr(settings, "VAULT_GIT_PROVIDER", "github")
    monkeypatch.setattr(settings, "VAULT_GIT_AUTH_METHOD", "auto")
    monkeypatch.setattr(settings, "VAULT_GIT_HTTP_USERNAME", "")
    monkeypatch.setattr(settings, "VAULT_GIT_HTTP_ACCESS_TOKEN", "")
    monkeypatch.setattr(settings, "VAULT_GIT_HTTP_TOKEN", "")
    monkeypatch.setattr(settings, "VAULT_GIT_SSH_KEY_PATH", "")
    monkeypatch.setattr(settings, "VAULT_GIT_SSH_KEY", "")
    monkeypatch.setattr(settings, "VAULT_GIT_SSH_KNOWN_HOSTS_PATH", "")

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


def test_pushes_to_configured_branch(vault_env: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    default_branch = vault_env.vault.active_branch.name
    branch = vault_env.seed.create_head("wiki")
    vault_env.seed.head.reference = branch
    vault_env.seed.head.reset(index=True, working_tree=True)
    (vault_env.seed_path / "wiki-seed.md").write_text("# Wiki seed\n", encoding="utf-8")
    _commit_and_push(vault_env.seed, "create wiki branch")

    # Re-clone the vault from the remote default branch, then explicitly target
    # the wiki branch. GitSync must not push to the default branch.
    vault_env.vault.close()
    import shutil

    shutil.rmtree(vault_env.vault_path)
    git.Repo.clone_from(str(vault_env.remote), str(vault_env.vault_path))
    monkeypatch.setattr(settings, "VAULT_GIT_URL", str(vault_env.remote))
    monkeypatch.setattr(settings, "VAULT_GITHUB_URL", "")
    monkeypatch.setattr(settings, "VAULT_GIT_BRANCH", "wiki")
    monkeypatch.setattr(settings, "VAULT_GIT_PROVIDER", "bitbucket")

    sync = GitSync()
    sync.setup()
    (vault_env.vault_path / "wiki-note.md").write_text("# Wiki note\n", encoding="utf-8")
    sync.push("remember: wiki note")

    remote = git.Repo(vault_env.remote)
    assert remote.commit("refs/heads/wiki").tree["wiki-note.md"]
    assert "wiki-note.md" not in remote.commit(f"refs/heads/{default_branch}").tree


def test_http_credentials_are_not_persisted_in_remote_url(
    vault_env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "VAULT_GITHUB_URL", "")
    monkeypatch.setattr(settings, "VAULT_GIT_URL", "https://bitbucket.org/team/vault.git")
    monkeypatch.setattr(settings, "VAULT_GIT_PROVIDER", "bitbucket")
    monkeypatch.setattr(settings, "VAULT_GIT_HTTP_ACCESS_TOKEN", "token-with:special@chars")
    monkeypatch.setattr(settings, "VAULT_GIT_HTTP_USERNAME", "x-token-auth")

    sync = GitSync()
    sync._ensure_auth_remote(vault_env.vault)

    assert vault_env.vault.remotes["origin"].url == "https://bitbucket.org/team/vault.git"
    assert "token-with" not in vault_env.vault.remotes["origin"].url
    assert _without_http_credentials("https://user:secret@example.com/vault.git") == (
        "https://example.com/vault.git"
    )


def test_ssh_environment_uses_key_and_known_hosts(
    vault_env: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    key_path = vault_env.vault_path.parent / "id_ed25519"
    key_path.write_text("fake-key", encoding="utf-8")
    known_hosts = vault_env.vault_path.parent / "known_hosts"
    known_hosts.write_text("example host key", encoding="utf-8")
    monkeypatch.setattr(settings, "VAULT_GIT_URL", "git@bitbucket.org:team/vault.git")
    monkeypatch.setattr(settings, "VAULT_GIT_PROVIDER", "bitbucket")
    monkeypatch.setattr(settings, "VAULT_GIT_AUTH_METHOD", "ssh")
    monkeypatch.setattr(settings, "VAULT_GIT_SSH_KEY_PATH", str(key_path))
    monkeypatch.setattr(settings, "VAULT_GIT_SSH_KNOWN_HOSTS_PATH", str(known_hosts))

    sync = GitSync()
    with sync._git_environment() as env:
        assert env["GIT_TERMINAL_PROMPT"] == "0"
        assert "-i" in env["GIT_SSH_COMMAND"]
        assert str(key_path) in env["GIT_SSH_COMMAND"]
        assert f"UserKnownHostsFile={known_hosts}" in env["GIT_SSH_COMMAND"]
