"""Synthetic subprocess tests for the managed Git transport boundary."""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import Any, cast

import pytest

from second_brain.wiki import remote as remote_module
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError


def _shim(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, body: str) -> ManagedGitSync:
    executable = tmp_path / "git"
    executable.write_text(f"#!{sys.executable}\n" + body, encoding="utf-8")
    executable.chmod(0o700)
    monkeypatch.setenv("PATH", str(tmp_path) + os.pathsep + os.environ.get("PATH", ""))
    sync = ManagedGitSync.__new__(ManagedGitSync)
    sync.repo = tmp_path / "isolated.git"
    sync.ssh_known_hosts = None
    return sync


def _running(pid: int) -> bool:
    # A killed child may briefly remain a zombie until its reaper collects it.
    status = Path(f"/proc/{pid}/stat")
    if Path("/proc").is_dir():
        try:
            state = status.read_text().split(")", 1)[1].split()[0]
        except FileNotFoundError:
            return False  # The reaper may remove the process between observations.
        if state == "Z":
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.skipif(os.name != "posix", reason="Process group cleanup requires POSIX")
def test_git_timeout_kills_pipe_holding_descendant_and_sanitizes_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pid_file = tmp_path / "child.pid"
    sync = _shim(
        tmp_path,
        monkeypatch,
        "import pathlib, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n"
        "print('synthetic-private-transport-secret', file=sys.stderr, flush=True)\n"
        "time.sleep(30)\n",
    )
    monkeypatch.setattr(remote_module, "GIT_TIMEOUT_SECONDS", 0.2)
    child_pid: int | None = None
    try:
        start = time.monotonic()
        with pytest.raises(WikiError) as caught:
            sync._run("ls-remote", "https://example.invalid/synthetic.git")
        elapsed = time.monotonic() - start
        assert elapsed < 3, "A descendant retaining pipes must not defeat the Git timeout"
        assert caught.value.code == "remote_unavailable"
        assert "synthetic-private-transport-secret" not in str(caught.value)
        assert "example.invalid" not in str(caught.value)
        assert pid_file.exists(), "The shim must actually start a pipe-holding descendant"
        child_pid = int(pid_file.read_text())
        deadline = time.monotonic() + 1
        while _running(child_pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not _running(child_pid), "Timed-out transport descendants must be terminated"
    finally:
        if child_pid is None and pid_file.exists():
            child_pid = int(pid_file.read_text())
        if child_pid is not None and _running(child_pid):
            with suppress(ProcessLookupError):
                os.kill(child_pid, signal.SIGKILL)


@pytest.mark.skipif(os.name != "posix", reason="Executable shim uses a POSIX shebang")
def test_git_transport_preserves_agent_but_excludes_ambient_askpass(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sync = _shim(
        tmp_path,
        monkeypatch,
        "import json, os\n"
        "print(json.dumps({name: os.environ.get(name) for name in "
        "['SSH_AUTH_SOCK', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GIT_ASKPASS', "
        "'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT']}))\n",
    )
    monkeypatch.setenv("SSH_AUTH_SOCK", "/synthetic/agent.sock")
    monkeypatch.setenv("SSH_ASKPASS", "/synthetic/ambient-helper")
    monkeypatch.setenv("SSH_ASKPASS_REQUIRE", "force")
    monkeypatch.setenv("GIT_ASKPASS", "/synthetic/git-helper")
    monkeypatch.setenv("GIT_SSH_COMMAND", "synthetic-unsafe-ssh")
    observed = json.loads(sync._run("ls-remote", "git@example.invalid:synthetic.git"))
    assert observed["SSH_AUTH_SOCK"] == "/synthetic/agent.sock"
    assert observed["SSH_ASKPASS"] is None
    assert observed["SSH_ASKPASS_REQUIRE"] is None
    assert observed["GIT_ASKPASS"] is None
    assert observed["GIT_TERMINAL_PROMPT"] == "0"
    ssh_command = observed["GIT_SSH_COMMAND"]
    assert ssh_command != "synthetic-unsafe-ssh"
    assert ssh_command is None or "BatchMode=yes" in ssh_command


@pytest.mark.skipif(os.name != "posix", reason="Process group cleanup requires POSIX")
def test_git_interruption_kills_transport_and_descendant_before_propagating(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pid_file = tmp_path / "interrupt-child.pid"
    sync = _shim(
        tmp_path,
        monkeypatch,
        "import pathlib, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        f"pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))\n"
        "time.sleep(30)\n",
    )
    original = cast(Callable[..., tuple[bytes, bytes]], subprocess.Popen.communicate)
    interrupted: list[subprocess.Popen[bytes]] = []

    def interrupt_once(
        process: subprocess.Popen[bytes], *args: Any, **kwargs: Any
    ) -> tuple[bytes, bytes]:
        if not interrupted:
            interrupted.append(process)
            deadline = time.monotonic() + 2
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            assert pid_file.exists(), "The descendant must start before interruption"
            raise KeyboardInterrupt
        return original(process, *args, **kwargs)

    monkeypatch.setattr(subprocess.Popen, "communicate", interrupt_once)
    child_pid: int | None = None
    try:
        with pytest.raises(KeyboardInterrupt):
            sync._run("ls-remote", "https://example.invalid/synthetic.git")
        child_pid = int(pid_file.read_text())
        assert interrupted[0].poll() is not None, "The interrupted Git process must be reaped"
        deadline = time.monotonic() + 1
        while _running(child_pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not _running(child_pid), "Interruption must terminate transport descendants"
    finally:
        if interrupted and interrupted[0].poll() is None:
            with suppress(ProcessLookupError):
                os.killpg(interrupted[0].pid, signal.SIGKILL)
            interrupted[0].wait(timeout=2)
        if child_pid is None and pid_file.exists():
            child_pid = int(pid_file.read_text())
        if child_pid is not None and _running(child_pid):
            with suppress(ProcessLookupError):
                os.kill(child_pid, signal.SIGKILL)
