"""Credential transport regression tests using synthetic secrets and loopback Git."""

from __future__ import annotations

import base64
import os
import shlex
import stat
import subprocess
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from second_brain.wiki.delivery_runtime import configured_delivery
from second_brain.wiki.git_config import GitCredentials
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore

AuthenticatedGit = tuple[str, Path, Path, str, list[str]]


USERNAME = "synthetic-user"
TOKEN = "synthetic token ' \" $HOME `uname` ; & / + ="


def git(path: Path, *args: str, env: dict[str, str] | None = None) -> str:
    return (
        subprocess.check_output(
            ["git", "-C", str(path), *args], env=env, stderr=subprocess.PIPE, timeout=15
        )
        .decode()
        .strip()
    )


def test_http_askpass_returns_literal_credentials_and_cleans_up() -> None:
    credentials = GitCredentials(method="http", username=USERNAME, token=TOKEN)
    assert TOKEN not in repr(credentials)
    with credentials.environment() as env:
        helper = Path(env["GIT_ASKPASS"])
        assert helper.is_file()
        assert helper.stat().st_mode & stat.S_IXUSR
        assert not helper.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO)
        for prompt, answer in [
            ("Username for 'https://example.test':", USERNAME),
            ("Password for 'https://synthetic-user@example.test':", TOKEN),
        ]:
            result = subprocess.check_output([str(helper), prompt], env=env, timeout=5)
            assert result.decode().rstrip("\n") == answer
        assert TOKEN not in helper.read_text()
    assert not helper.exists()


def test_http_askpass_cleanup_on_exception() -> None:
    with (
        pytest.raises(RuntimeError, match="synthetic failure"),
        GitCredentials(method="http", username=USERNAME, token=TOKEN).environment() as env,
    ):
        helper = Path(env["GIT_ASKPASS"])
        raise RuntimeError("synthetic failure")
    assert not helper.exists()


def test_inline_ssh_key_is_private_ephemeral_and_ssh_is_strict() -> None:
    key_text = "SYNTHETIC PRIVATE KEY MATERIAL\n"
    credentials = GitCredentials(method="ssh", ssh_key=key_text)
    assert key_text.strip() not in repr(credentials)
    with credentials.environment() as env:
        command = shlex.split(env["GIT_SSH_COMMAND"])
        # ssh -G parses the actual command without connecting or needing a valid key.
        resolved = subprocess.check_output(
            [*command, "-G", "example.test"], env=env, stderr=subprocess.PIPE, timeout=5
        ).decode()
        options = dict(line.split(" ", 1) for line in resolved.splitlines())
        assert options["stricthostkeychecking"] in {"yes", "true"}
        assert options["batchmode"] == "yes"
        assert options["identitiesonly"] == "yes"
        assert "-F" in command and command[command.index("-F") + 1] == os.devnull
        key_path = Path(options["identityfile"])
        assert key_path.read_text() == key_text
        assert stat.S_IMODE(key_path.stat().st_mode) == 0o600
    assert not key_path.exists()


@pytest.fixture
def authenticated_git(tmp_path: Path) -> Iterator[AuthenticatedGit]:
    """Serve real smart HTTP Git; no credentials leave the loopback interface."""
    remote = tmp_path / "remote.git"
    source = tmp_path / "source"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    subprocess.run(["git", "clone", str(remote), str(source)], check=True, capture_output=True)
    git(remote, "config", "http.receivepack", "true")
    git(source, "config", "user.name", "Synthetic Test")
    git(source, "config", "user.email", "test@localhost")
    git(source, "checkout", "-b", "wiki")
    (source / "Alpha.md").write_text("# Alpha\nOriginal.\n")
    git(source, "add", ".")
    git(source, "commit", "-m", "seed")
    git(source, "push", "origin", "wiki")
    baseline = git(source, "rev-parse", "HEAD")
    expected_auth = "Basic " + base64.b64encode(f"{USERNAME}:{TOKEN}".encode()).decode()
    authenticated_requests: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            self.respond()

        def do_POST(self) -> None:
            self.respond()

        def respond(self) -> None:
            if self.headers.get("Authorization") != expected_auth:
                self.send_response(401)
                self.send_header("WWW-Authenticate", 'Basic realm="Synthetic Git"')
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            authenticated_requests.append(self.path)
            url = urlsplit(self.path)
            env = dict(
                os.environ,
                GIT_PROJECT_ROOT=str(tmp_path),
                GIT_HTTP_EXPORT_ALL="1",
                PATH_INFO=url.path,
                QUERY_STRING=url.query,
                REQUEST_METHOD=self.command,
                REMOTE_USER=USERNAME,
                CONTENT_TYPE=self.headers.get("Content-Type", ""),
                CONTENT_LENGTH=self.headers.get("Content-Length", "0"),
            )
            body = self.rfile.read(int(env["CONTENT_LENGTH"]))
            result = subprocess.run(
                ["git", "http-backend"],
                env=env,
                input=body,
                capture_output=True,
                check=True,
                timeout=15,
            )
            headers, payload = result.stdout.split(b"\r\n\r\n", 1)
            fields = [line.decode().split(":", 1) for line in headers.split(b"\r\n")]
            status = next((int(v.strip().split()[0]) for k, v in fields if k == "Status"), 200)
            self.send_response(status)
            for name, value in fields:
                if name != "Status":
                    self.send_header(name, value.strip())
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield (
            f"http://127.0.0.1:{server.server_port}/remote.git",
            remote,
            source,
            baseline,
            authenticated_requests,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def test_real_http_clone_fetch_and_push(
    authenticated_git: AuthenticatedGit, tmp_path: Path
) -> None:
    url, remote, source, baseline, requests = authenticated_git
    credentials = GitCredentials(method="http", username=USERNAME, token=TOKEN)
    clone = tmp_path / "http-clone"
    with credentials.environment() as env:
        subprocess.run(
            ["git", "clone", "--branch", "wiki", url, str(clone)],
            env={**os.environ, **env},
            check=True,
            capture_output=True,
            timeout=15,
        )
    assert git(clone, "rev-parse", "HEAD") == baseline
    config = (clone / ".git" / "config").read_text()
    assert USERNAME not in config
    assert TOKEN not in config

    store = WikiStore(tmp_path / "vault")
    sync = ManagedGitSync(store, url, "wiki", credentials=credentials)
    sync.pull(None, baseline, "credential-pull")
    page = store.get_page("Alpha")
    assert page is not None
    store.save_page("Alpha", "# Alpha\nPublished with credentials.\n", page["revision"], "edit")
    published = sync.push(store._head(), baseline, "credential-push")["published_revision"]
    assert git(remote, "show", published + ":Alpha.md") == "# Alpha\nPublished with credentials."
    assert any("git-upload-pack" in path for path in requests)
    assert any("git-receive-pack" in path for path in requests)
    for config_path in [store.repo / "config", sync.repo / "config"]:
        contents = config_path.read_text()
        assert USERNAME not in contents
        assert TOKEN not in contents


def test_ssh_key_file_is_reused_without_deletion_or_path_leak(tmp_path: Path) -> None:
    key = tmp_path / "synthetic identity with spaces"
    key.write_text("SYNTHETIC KEY\n")
    key.chmod(0o600)
    credentials = GitCredentials(method="ssh", ssh_key_path=str(key))
    assert str(key) not in repr(credentials)
    with credentials.environment() as env:
        command = shlex.split(env["GIT_SSH_COMMAND"])
        assert command[command.index("-i") + 1] == str(key)
    assert key.read_text() == "SYNTHETIC KEY\n"


def test_inline_ssh_key_cleanup_on_exception() -> None:
    with (
        pytest.raises(RuntimeError, match="synthetic failure"),
        GitCredentials(method="ssh", ssh_key="SYNTHETIC KEY\n").environment() as env,
    ):
        command = shlex.split(env["GIT_SSH_COMMAND"])
        key = Path(command[command.index("-i") + 1])
        assert key.is_file()
        raise RuntimeError("synthetic failure")
    assert not key.exists()


def test_configured_legacy_credentials_automatically_pull_and_push(
    authenticated_git: AuthenticatedGit, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    url, remote, _, _, _ = authenticated_git
    for name in list(os.environ):
        if name.startswith(("VAULT_", "SECOND_BRAIN_WIKI_")):
            monkeypatch.delenv(name)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("VAULT_GITHUB_URL", url)
    monkeypatch.setenv("VAULT_GITHUB_PAT", TOKEN)
    monkeypatch.setenv("VAULT_GIT_HTTP_USERNAME", USERNAME)
    monkeypatch.setenv("VAULT_GIT_BRANCH", "wiki")
    monkeypatch.setenv("SECOND_BRAIN_WIKI_GIT_PREFIX", "")
    store = WikiStore(tmp_path / "automatic-vault")
    delivery = configured_delivery(store, IndexCoordinator(store))
    page = store.get_page("Alpha")
    assert page and page["markdown"] == "# Alpha\nOriginal.\n"
    assert delivery.synchronize
    store.save_page("Alpha", "# Alpha\nConfigured authentication.\n", page["revision"], "edit")
    assert delivery.run_once()["remote"]["state"] == "current"
    assert git(remote, "show", "wiki:Alpha.md") == "# Alpha\nConfigured authentication."
    assert TOKEN not in (store.repo / "config").read_text()


def test_wrong_credentials_fail_without_url_or_secret_in_error(
    authenticated_git: AuthenticatedGit, tmp_path: Path
) -> None:
    url, _, _, baseline, _ = authenticated_git
    store = WikiStore(tmp_path / "denied-vault")
    credentials = GitCredentials(method="http", username=USERNAME, token="synthetic-wrong-token")
    sync = ManagedGitSync(store, url, "wiki", credentials=credentials)
    with pytest.raises(WikiError) as caught:
        sync.pull(None, baseline, "denied")
    assert caught.value.code == "remote_unavailable"
    assert url not in str(caught.value)
    assert credentials.token not in str(caught.value)
    assert store._head() == ""
