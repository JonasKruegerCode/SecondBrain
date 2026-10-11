"""Opt-in, synthetic OpenSSH/agent/Git acceptance with disposable credentials."""

from __future__ import annotations

import os
import pwd
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time
from collections.abc import Iterator
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("SECOND_BRAIN_SSH_ACCEPTANCE") != "1",
        reason="Set SECOND_BRAIN_SSH_ACCEPTANCE=1 for disposable OpenSSH acceptance",
    ),
]


def command(*args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        args, env=env, check=True, capture_output=True, text=True, timeout=10
    ).stdout.strip()


def stop(process: subprocess.Popen[bytes]) -> None:
    # Kill the entire private session, including sshd's per-connection children.
    with suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGKILL)
    process.wait(timeout=5)


@dataclass
class SSHGit:
    root: Path
    remote: Path
    url: str
    trust: Path
    key: Path
    socket: Path
    env: dict[str, str]

    def refs(self) -> str:
        return command("git", "--git-dir", str(self.remote), "show-ref", "--head")

    def sync(self, store: WikiStore, trust: Path | None = None) -> ManagedGitSync:
        return ManagedGitSync(
            store, self.url, "wiki", "notes", ssh_known_hosts=str(trust or self.trust)
        )


@pytest.fixture
def ssh_git(monkeypatch: pytest.MonkeyPatch) -> Iterator[SSHGit]:
    if os.name != "posix":
        pytest.fail("OpenSSH acceptance requires a POSIX host")
    binaries = {
        name: shutil.which(name)
        for name in ("git", "ssh", "sshd", "ssh-agent", "ssh-add", "ssh-keygen")
    }
    missing = [name for name, path in binaries.items() if path is None]
    if missing:
        pytest.fail("Install acceptance dependencies: " + ", ".join(missing))
    processes: list[subprocess.Popen[bytes]] = []
    # A short owned pathname also stays below Unix-domain socket length limits.
    # StrictModes checks authorized_keys ancestors. Keep the owned directory
    # beneath the user's home rather than world-writable /tmp.
    with tempfile.TemporaryDirectory(prefix="wiki-ssh-", dir=Path.home()) as temporary:
        root = Path(temporary)
        try:
            host = root / "host"
            key = root / "client"
            for path in (host, key):
                command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path))
            authorized = root / "authorized_keys"
            authorized.write_text(key.with_suffix(".pub").read_text(), encoding="utf-8")
            authorized.chmod(0o600)
            remote = root / "remote.git"
            command("git", "init", "--bare", str(remote))
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            trust = root / "known_hosts"
            host_public = " ".join(host.with_suffix(".pub").read_text().split()[:2])
            trust.write_text(f"[127.0.0.1]:{port} {host_public}\n", encoding="utf-8")
            config = root / "sshd_config"
            config.write_text(
                f"Port {port}\nListenAddress 127.0.0.1\nHostKey {host}\n"
                f"PidFile {root / 'sshd.pid'}\nAuthorizedKeysFile {authorized}\n"
                f"AllowUsers {pwd.getpwuid(os.getuid()).pw_name}\n"
                "StrictModes yes\nUsePAM no\nPasswordAuthentication no\n"
                "KbdInteractiveAuthentication no\nPubkeyAuthentication yes\n"
                "PermitRootLogin prohibit-password\nAllowAgentForwarding no\n"
                "AllowTcpForwarding no\nX11Forwarding no\nPermitUserRC no\nLogLevel VERBOSE\n",
                encoding="utf-8",
            )
            agent_socket = root / "agent.sock"
            with (
                (root / "agent.log").open("wb") as agent_log,
                (root / "sshd.log").open("wb") as server_log,
            ):
                agent = subprocess.Popen(
                    [str(binaries["ssh-agent"]), "-D", "-a", str(agent_socket)],
                    stdout=agent_log,
                    stderr=agent_log,
                    start_new_session=True,
                )
                processes.append(agent)
                env = dict(os.environ, SSH_AUTH_SOCK=str(agent_socket))
                env.pop("SSH_AGENT_PID", None)
                deadline = time.monotonic() + 5
                while not agent_socket.exists():
                    if agent.poll() is not None or time.monotonic() >= deadline:
                        pytest.fail(
                            "Disposable ssh-agent did not become ready: "
                            + (root / "agent.log").read_text()
                        )
                    time.sleep(0.05)
                command("ssh-add", str(key), env=env)
                server = subprocess.Popen(
                    [str(binaries["sshd"]), "-D", "-e", "-f", str(config)],
                    stdout=server_log,
                    stderr=server_log,
                    start_new_session=True,
                )
                processes.append(server)
                ssh = shlex.join(
                    [
                        "ssh",
                        "-F",
                        os.devnull,
                        "-o",
                        "BatchMode=yes",
                        "-o",
                        "StrictHostKeyChecking=yes",
                        "-o",
                        f"UserKnownHostsFile={trust}",
                        "-o",
                        f"GlobalKnownHostsFile={os.devnull}",
                        "-o",
                        "IdentityFile=none",
                        "-o",
                        "ConnectTimeout=1",
                        "-o",
                        "PasswordAuthentication=no",
                    ]
                )
                url = f"ssh://127.0.0.1:{port}{remote}"
                deadline = time.monotonic() + 10
                while True:
                    if server.poll() is not None:
                        pytest.fail("Disposable sshd exited: " + (root / "sshd.log").read_text())
                    probe = subprocess.run(
                        ["git", "ls-remote", "--", url],
                        env=dict(
                            env,
                            GIT_SSH_COMMAND=ssh,
                            GIT_CONFIG_GLOBAL=os.devnull,
                            GIT_CONFIG_NOSYSTEM="1",
                            GIT_TERMINAL_PROMPT="0",
                        ),
                        capture_output=True,
                        timeout=3,
                    )
                    if probe.returncode == 0:
                        break
                    if time.monotonic() >= deadline:
                        pytest.fail(
                            "Authenticated disposable Git readiness failed: "
                            + probe.stderr.decode()
                            + (root / "sshd.log").read_text()
                        )
                    time.sleep(0.1)
                monkeypatch.setenv("SSH_AUTH_SOCK", str(agent_socket))
                monkeypatch.delenv("SSH_AGENT_PID", raising=False)
                yield SSHGit(root, remote, url, trust, key, agent_socket, env)
        finally:
            for process in reversed(processes):
                stop(process)


def publish(fixture: SSHGit, path: Path) -> tuple[WikiStore, str, dict[str, Any]]:
    store = WikiStore(path)
    store.save_page("Alpha", "# Alpha\nSynthetic SSH content", None, "create")
    base = store._head()
    return store, base, fixture.sync(store).push(base, None, "publish")


def test_authenticated_push_pull_and_restart(ssh_git: SSHGit, tmp_path: Path) -> None:
    store, base, receipt = publish(ssh_git, tmp_path / "writer")
    before = ssh_git.refs()
    restarted = ssh_git.sync(WikiStore(store.path))
    assert restarted.push(base, None, "publish") == receipt
    assert ssh_git.refs() == before
    assert restarted.inspect()["observed_remote_revision"] == receipt["published_revision"]
    target = WikiStore(tmp_path / "reader")
    pulled = ssh_git.sync(target).pull(None, receipt["published_revision"], "pull")
    assert target.get_page("Alpha") is not None
    resumed = ssh_git.sync(WikiStore(target.path))
    assert resumed.pull(None, receipt["published_revision"], "pull") == pulled
    assert ssh_git.refs() == before


@pytest.mark.parametrize("failure", ["absent-host", "wrong-host", "empty-agent", "wrong-agent"])
def test_refusal_preserves_remote_and_content(
    ssh_git: SSHGit, tmp_path: Path, failure: str
) -> None:
    store, _, receipt = publish(ssh_git, tmp_path / "writer")
    store.save_page("Beta", "# Beta\nUnpublished", store._head(), "edit")
    base = store._head()
    before = ssh_git.refs()
    trust = ssh_git.trust
    if failure in {"absent-host", "wrong-host"}:
        trust = ssh_git.root / "untrusted_hosts"
        trust.write_text("", encoding="utf-8")
        if failure == "wrong-host":
            # The client public key is a different valid key, never the host key.
            endpoint = ssh_git.trust.read_text().split()[0]
            public = " ".join(ssh_git.key.with_suffix(".pub").read_text().split()[:2])
            trust.write_text(f"{endpoint} {public}\n", encoding="utf-8")
    else:
        command("ssh-add", "-D", env=ssh_git.env)
        if failure == "wrong-agent":
            wrong = ssh_git.root / "wrong-client"
            command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(wrong))
            command("ssh-add", str(wrong), env=ssh_git.env)
    sync = ssh_git.sync(store, trust)
    with pytest.raises(WikiError) as failed:
        sync.push(base, receipt["published_revision"], "refused-push")
    assert failed.value.code == "remote_unavailable"
    assert store._head() == base
    assert ssh_git.refs() == before
    target = WikiStore(tmp_path / "reader")
    initial = target._head()
    with pytest.raises(WikiError) as failed_pull:
        ssh_git.sync(target, trust).pull(None, receipt["published_revision"], "refused-pull")
    assert failed_pull.value.code == "remote_unavailable"
    assert target._head() == initial
    assert target.get_page("Alpha") is None
    assert ssh_git.refs() == before

    # Deliberately repair the same transport boundary, then resume the failed
    # requests with identical IDs and revisions instead of adopting a new head.
    if failure in {"absent-host", "wrong-host"}:
        trust.write_text(ssh_git.trust.read_text(), encoding="utf-8")
    else:
        command("ssh-add", "-D", env=ssh_git.env)
        command("ssh-add", str(ssh_git.key), env=ssh_git.env)
    imported = ssh_git.sync(target, trust).pull(
        None, receipt["published_revision"], "refused-pull"
    )
    assert imported["last_verified_remote_revision"] == receipt["published_revision"]
    assert target.get_page("Alpha") is not None
    assert target.get_page("Beta") is None  # Pull stays pinned to the reviewed old snapshot.
    recovered = sync.push(base, receipt["published_revision"], "refused-push")
    assert recovered["published_revision"] != receipt["published_revision"]
    assert sync.push(base, receipt["published_revision"], "refused-push") == recovered
    assert ssh_git.sync(target, trust).pull(
        None, receipt["published_revision"], "refused-pull"
    ) == imported
