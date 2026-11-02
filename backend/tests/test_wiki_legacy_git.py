"""Configured vault Git is an automatic managed startup, not a manual import."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from second_brain.wiki.delivery_runtime import configured_delivery
from second_brain.wiki.git_config import legacy_git_settings
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiError, WikiStore


def git(path: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(path), *args]).decode().strip()


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for key in list(os.environ):
        if key.startswith(("VAULT_", "SECOND_BRAIN_WIKI_")):
            monkeypatch.delenv(key)
    launch = tmp_path / "launch"
    launch.mkdir()
    monkeypatch.chdir(launch)


def repository(tmp_path: Path, *, content: bool = True) -> tuple[Path, Path]:
    remote, source = tmp_path / "remote.git", tmp_path / "source"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(["git", "clone", str(remote), str(source)], check=True, capture_output=True)
    git(source, "config", "user.name", "Synthetic Test")
    git(source, "config", "user.email", "test@localhost")
    git(source, "checkout", "-b", "archive")
    (source / "README.md").write_text("# Synthetic repository\n")
    if content:
        pages = source / "1_knowledge/wiki"
        pages.mkdir(parents=True)
        (pages / "Home.md").write_text("# Home\n\n[[Article]]\n")
        (pages / "Article.md").write_text("# Article\n\nOriginal synthetic content.\n")
    git(source, "add", ".")
    git(source, "commit", "-m", "Synthetic initial wiki")
    git(source, "push", "origin", "archive")
    git(remote, "symbolic-ref", "HEAD", "refs/heads/archive")
    return remote, source


@pytest.mark.parametrize("url_name", ["VAULT_GIT_URL", "VAULT_GITHUB_URL"])
def test_legacy_url_start_pull_edit_push_external_change_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, url_name: str
) -> None:
    remote, source = repository(tmp_path)
    monkeypatch.setenv(url_name, str(remote))
    store = WikiStore(tmp_path / "managed")
    delivery = configured_delivery(store, IndexCoordinator(store))
    assert delivery.synchronize
    assert delivery.remote is not None and delivery.remote.branch == "archive"
    article = store.get_page("Article")
    assert article and "Original synthetic" in article["markdown"]
    store.save_page("Article", "# Article\nLocal edit.\n", article["revision"], "local")
    assert delivery.run_once()["remote"]["state"] == "current"
    assert git(remote, "show", "archive:1_knowledge/wiki/Article.md") == "# Article\nLocal edit."
    git(source, "pull", "--no-rebase", "origin", "archive")
    (source / "1_knowledge/wiki/Home.md").write_text("# Home\nExternal addition [[Article]].\n")
    git(source, "add", ".")
    git(source, "commit", "-m", "External synthetic edit")
    git(source, "push", "origin", "archive")
    restarted = configured_delivery(store, IndexCoordinator(store))
    assert restarted.run_once()["remote"]["state"] == "current"
    home = store.get_page("Home")
    assert home and "External addition" in home["markdown"]
    assert store.search("External addition")
    assert git(remote, "show", "archive:README.md") == "# Synthetic repository"


def test_existing_dotenv_without_new_git_flags(tmp_path: Path) -> None:
    remote, _ = repository(tmp_path)
    Path(".env").write_text(f"VAULT_GITHUB_URL={remote}\nVAULT_GIT_AUTH_METHOD=none\n")
    store = WikiStore(tmp_path / "managed")
    delivery = configured_delivery(store, IndexCoordinator(store))
    assert delivery.synchronize
    assert store.get_page("Home")


def test_explicit_disable_ignores_inherited_legacy_git(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VAULT_GITHUB_URL", "https://invalid.example/wiki.git")
    monkeypatch.setenv("VAULT_GIT_AUTH_METHOD", "invalid")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_SYNC", "0")
    store = WikiStore(tmp_path / "managed")
    assert configured_delivery(store, IndexCoordinator(store)).remote is None
    assert store._head() == ""


@pytest.mark.parametrize("committed", [False, True])
def test_empty_git_and_repository_without_wiki_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, committed: bool
) -> None:
    if committed:
        remote, _ = repository(tmp_path, content=False)
        branch = "archive"
    else:
        remote = tmp_path / "empty.git"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
        branch = "main"
    monkeypatch.setenv("VAULT_GIT_URL", str(remote))
    store = WikiStore(tmp_path / "managed")
    delivery = configured_delivery(store, IndexCoordinator(store))
    assert store._head() == ""
    store.save_page("Home", "# Home\nFirst article.\n", None, "first")
    assert delivery.run_once()["remote"]["state"] == "current"
    assert git(remote, "show", branch + ":1_knowledge/wiki/Home.md") == "# Home\nFirst article."
    if committed:
        assert git(remote, "show", branch + ":README.md") == "# Synthetic repository"


def test_unrelated_populated_managed_vault_is_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    remote, _ = repository(tmp_path)
    monkeypatch.setenv("VAULT_GIT_URL", str(remote))
    store = WikiStore(tmp_path / "managed")
    store.save_page("Home", "# Unrelated local wiki\n", None, "unrelated")
    before = store._head()
    with pytest.raises(WikiError) as caught:
        configured_delivery(store, IndexCoordinator(store))
    assert caught.value.code == "remote_bootstrap_conflict"
    assert store._head() == before


@pytest.mark.parametrize(
    "token_key", ["VAULT_GIT_HTTP_ACCESS_TOKEN", "VAULT_GIT_HTTP_TOKEN", "VAULT_GITHUB_PAT"]
)
def test_legacy_http_token_aliases_and_new_url_precedence(
    monkeypatch: pytest.MonkeyPatch, token_key: str
) -> None:
    monkeypatch.setenv("VAULT_GITHUB_URL", "https://old.example/wiki.git")
    monkeypatch.setenv("VAULT_GIT_URL", "https://new.example/wiki.git")
    monkeypatch.setenv(token_key, "synthetic-token-not-a-secret")
    target, _, credentials, _ = legacy_git_settings()
    assert target == "https://new.example/wiki.git"
    assert credentials.method == "http" and credentials.username == "oauth2"
    assert credentials.token == "synthetic-token-not-a-secret"
    assert credentials.token not in repr(credentials)


def test_bitbucket_token_and_explicit_target_ssh_selection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VAULT_GIT_PROVIDER", "bitbucket")
    monkeypatch.setenv("VAULT_GIT_URL", "https://example.invalid/wiki.git")
    monkeypatch.setenv("VAULT_GIT_HTTP_TOKEN", "synthetic-bitbucket-token")
    monkeypatch.setenv("VAULT_GITHUB_PAT", "synthetic-unused-token")
    _, _, credentials, _ = legacy_git_settings()
    assert credentials.username == "x-token-auth"
    assert credentials.token == "synthetic-bitbucket-token"
    _, _, ssh, _ = legacy_git_settings("git@example.invalid:wiki.git")
    assert ssh.method == "ssh"
