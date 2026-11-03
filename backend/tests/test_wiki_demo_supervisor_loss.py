"""Owned POSIX SIGKILL boundaries; no OS crash or Windows recovery claim."""

from __future__ import annotations

import contextlib
import ctypes
import json
import os
import runpy
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_SUPERVISOR = r"""
import json, os, runpy, select, signal, subprocess, sys
from pathlib import Path
script, fixture, ledger, receipt, boundary, number = sys.argv[1:]
number = int(number)
main = runpy.run_path(script, run_name="wiki_demo_loss_fixture")["main"]
g = main.__globals__
g["__file__"] = str(Path(fixture) / "scripts" / "run-wiki-demo.py")
real_popen = subprocess.Popen
owned = []
code = ("import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); "
        "s.listen(); print(s.getsockname()[1],flush=True); time.sleep(60)")
def launch(*args, **kwargs):
    child = real_popen([sys.executable, "-u", "-c", code],
                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                      start_new_session=True)
    # Publish ownership before a boundary can kill the supervisor. This ledger
    # is strictly a test owner's cleanup source, never the acceptance receipt.
    owned.append({"pid": child.pid, "port": None})
    Path(ledger).write_text(json.dumps(owned))
    assert select.select([child.stdout], [], [], 5)[0], "readiness timed out"
    owned[-1]["port"] = int(child.stdout.readline())
    Path(ledger).write_text(json.dumps(owned))
    if boundary == "spawn" and len(owned) == number:
        os.kill(os.getpid(), signal.SIGKILL)
    return child
original_record = g["_record_processes"]
def record(path, children, *, complete):
    original_record(path, children, complete=complete)
    if boundary == "complete" and complete:
        os.kill(os.getpid(), signal.SIGKILL)
g["subprocess"].Popen = launch
g["_record_processes"] = record
raise SystemExit(main(["--empty", "--vault", str(Path(fixture)/"vault"),
                       "--process-state", receipt]))
"""

pytestmark = pytest.mark.skipif(
    os.name != "posix", reason="requires POSIX process groups and SIGKILL",
)


def _port_open(port: int) -> bool:
    with socket.socket() as connection:
        connection.settimeout(0.05)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def _closed(children: list[dict[str, Any]]) -> None:
    deadline = time.monotonic() + 3
    while any(_port_open(child["port"]) for child in children) and time.monotonic() < deadline:
        time.sleep(0.025)
    assert all(not _port_open(child["port"]) for child in children), "owned socket leaked"


@contextlib.contextmanager
def _adopt_owned_orphans() -> Iterator[bool]:
    if sys.platform != "linux":
        yield False
        return
    # A process-local flag, restored even if launch/readiness fails. Reaping
    # below is restricted to ledger PIDs; never waitpid(-1) or foreign children.
    libc = ctypes.CDLL(None, use_errno=True)
    previous = ctypes.c_int()
    assert libc.prctl(37, ctypes.byref(previous), 0, 0, 0) == 0
    assert libc.prctl(36, 1, 0, 0, 0) == 0
    try:
        yield True
    finally:
        assert libc.prctl(36, previous.value, 0, 0, 0) == 0


def _reap_owned_orphans(owned: list[dict[str, Any]]) -> None:
    for child in owned:
        deadline = time.monotonic() + 3
        while True:
            pid, _ = os.waitpid(child["pid"], os.WNOHANG)
            if pid == child["pid"]:
                break
            assert time.monotonic() < deadline, "ledger-owned orphan was not reaped"
            time.sleep(0.025)


@contextlib.contextmanager
def _lost_supervisor(
    fixture: Path, receipt: Path, boundary: str, number: int,
) -> Iterator[tuple[subprocess.Popen[bytes], list[dict[str, Any]]]]:
    with (
        _adopt_owned_orphans() as adopted,
        _launch_lost_supervisor(fixture, receipt, boundary, number, adopted) as result,
    ):
        yield result


@contextlib.contextmanager
def _launch_lost_supervisor(
    fixture: Path, receipt: Path, boundary: str, number: int, adopted: bool,
) -> Iterator[tuple[subprocess.Popen[bytes], list[dict[str, Any]]]]:
    (fixture / "frontend" / "node_modules").mkdir(parents=True, exist_ok=True)
    ledger = fixture / "test-owner-ledger.json"
    process = subprocess.Popen(
        [sys.executable, "-c", _SUPERVISOR, str(_ROOT / "scripts" / "run-wiki-demo.py"),
         str(fixture), str(ledger), str(receipt), boundary, str(number)],
        env={**os.environ, "PYTHONPATH": str(_ROOT / "backend" / "src")},
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, start_new_session=True,
    )
    owned: list[dict[str, Any]] = []
    try:
        _, stderr = process.communicate(timeout=10)
        assert process.returncode == -signal.SIGKILL, stderr.decode()
        owned = json.loads(ledger.read_text())
        assert len(owned) == number
        assert all(_port_open(child["port"]) for child in owned)
        yield process, owned
    finally:
        # No guessed PIDs, production ports, or discovery of unrelated groups.
        if ledger.exists():
            owned = json.loads(ledger.read_text())
        for pid in [process.pid, *(child["pid"] for child in owned)]:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)
        process.wait(timeout=10)
        assert process.returncode is not None  # The directly owned supervisor is reaped.
        if process.stderr:
            process.stderr.close()
        ready = [child for child in owned if child["port"] is not None]
        _closed(ready)
        if adopted:
            _reap_owned_orphans(owned)
        # Other POSIX platforms prove socket closure only: their reparented
        # children cannot be waited for by this test owner.


@pytest.mark.parametrize(
    ("boundary", "number"), [("complete", 2), ("spawn", 1), ("spawn", 2)],
    ids=["complete-receipt", "first-popen-not-returned", "second-popen-not-returned"],
)
def test_hard_loss_reports_uncertain_cleanup_and_only_stops_recorded_groups(
    tmp_path: Path, boundary: str, number: int,
) -> None:
    state = tmp_path / "process-state.json"
    cleanup = runpy.run_path(str(_ROOT / "scripts" / "run-wiki-acceptance.py"))[
        "_stop_process_group"
    ]
    with _lost_supervisor(tmp_path, state, boundary, number) as (supervisor, owned):
        record = json.loads(state.read_text())
        known = owned if boundary == "complete" else owned[:-1]
        assert record == {
            "supervisor_pid": supervisor.pid,
            "process_group_ids": [child["pid"] for child in known],
            "launch_complete": boundary == "complete",
        }
        with pytest.raises(RuntimeError, match="cleanup could not be confirmed"):
            cleanup(supervisor, state)
        _closed(known)
        if boundary == "spawn":
            # The real receipt cannot identify a child whose Popen never returned.
            # Only the independent test-owner ledger may finish this orphan.
            assert _port_open(owned[-1]["port"])
            os.kill(owned[-1]["pid"], 0)


def test_hard_loss_actual_acceptance_retains_failed_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = runpy.run_path(str(_ROOT / "scripts" / "run-wiki-acceptance.py"))["main"]
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(tmp_path / "scripts" / "acceptance.py"))
    contexts: list[Any] = []
    owned: list[dict[str, Any]] = []

    def start(command: list[str], **kwargs: Any) -> subprocess.Popen[bytes]:
        vault = Path(command[command.index("--vault") + 1])
        vault.mkdir()
        (vault / "test-owned-input").write_text("disposable fixture")
        state = Path(command[command.index("--process-state") + 1])
        # Separately controlled phase inputs: no browser ran or fabricated
        # successful acceptance evidence was supplied.
        (state.parent / "browser-state.json").write_text("fixture input")
        (state.parent / "pages.json").write_text("fixture input")
        context = _lost_supervisor(tmp_path / "launcher", state, "complete", 2)
        supervisor, children = context.__enter__()
        contexts.append(context)
        owned.extend(children)
        return supervisor

    def no_browser(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("browser must not launch after supervisor loss")

    # Isolate launch substitution from the subprocess module used by the real
    # cleanup. The actual HTTP gate observes the already dead real supervisor.
    monkeypatch.setitem(namespace, "subprocess", SimpleNamespace(
        Popen=start, run=no_browser, STDOUT=subprocess.STDOUT,
        TimeoutExpired=subprocess.TimeoutExpired,
    ))
    monkeypatch.setitem(namespace, "_git_head", lambda root: None)
    try:
        assert main(["--first-start", "--startup-timeout", "1"]) == 1
        results = list((tmp_path / ".demo" / "acceptance").glob("*/result.json"))
        assert len(results) == 1
        result = json.loads(results[0].read_text())
        assert result["status"] == "failed"
        assert result["service_cleanup_ok"] is False
        assert result["vault_retained"] is True
        assert result["phase_inputs_retained"] is True
        assert result["process_records_retained"] is True
        assert "cleanup could not be confirmed" in result["failure"]
        _closed(owned)
    finally:
        for context in reversed(contexts):
            context.__exit__(None, None, None)
