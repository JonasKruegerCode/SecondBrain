"""Catchable signals during bounded cleanup of real owned POSIX groups."""

from __future__ import annotations

import contextlib
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

_PROBE = r'''
import json, os, runpy, select, signal, subprocess, sys
from pathlib import Path
script, ledger, receipt, signum, invalid = sys.argv[1:]
stop = runpy.run_path(script)["_stop_process_group"]
children = []
worker = (
    "import signal,socket,time; "
    "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
    "s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); "
    "print(s.getsockname()[1],flush=True); time.sleep(30)"
)
for code in [
    "import signal,time; signal.signal(signal.SIGTERM,lambda *a:exit(0)); "
    "print('0',flush=True); time.sleep(30)", worker, worker
]:
    child = subprocess.Popen(
        [sys.executable, "-u", "-c", code], stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, start_new_session=True)
    assert select.select([child.stdout], [], [], 5)[0], "readiness timed out"
    port = int(child.stdout.readline())
    children.append((child, port))
    Path(ledger).write_text(json.dumps([
        {"pid": c.pid, "port": p} for c,p in children
    ]))
supervisor = children[0][0]
Path(receipt).write_text(json.dumps({
    "supervisor_pid": supervisor.pid,
    "process_group_ids": [c.pid for c,p in children[1:]],
    "launch_complete": invalid == "0",
}))
previous = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}
original_wait = supervisor.wait
fired = False
def wait(*args, **kwargs):
    global fired
    if not fired:
        fired = True
        os.kill(os.getpid(), int(signum))
        os.kill(os.getpid(), int(signum))
    return original_wait(*args, **kwargs)
supervisor.wait = wait
failed = False
try:
    stop(supervisor, Path(receipt))
except RuntimeError:
    failed = True
assert failed == (invalid == "1"), "cleanup error was lost"
assert fired
assert all(signal.getsignal(s) == h for s,h in previous.items()), "handler leaked"
for child, port in children:
    child.wait(timeout=5)
    child.stdout.close()
    if port:
        import socket
        with socket.socket() as connection:
            connection.settimeout(.1)
            assert connection.connect_ex(('127.0.0.1', port)) != 0, "socket leaked"
print("owned groups stopped; handlers restored", flush=True)
'''


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX groups and signals")
@pytest.mark.parametrize("signum", [signal.SIGINT, signal.SIGTERM])
@pytest.mark.parametrize("invalid_receipt", [False, True])
def test_repeated_cleanup_signals_preserve_owned_termination_and_handlers(
    tmp_path: Path, signum: int, invalid_receipt: bool,
) -> None:
    script = Path(__file__).resolve().parents[2] / "scripts" / "run-wiki-acceptance.py"
    ledger = tmp_path / "owned.json"
    probe = subprocess.Popen(
        [sys.executable, "-c", _PROBE, str(script), str(ledger),
         str(tmp_path / "receipt.json"), str(int(signum)), str(int(invalid_receipt))],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True,
    )
    try:
        stdout, stderr = probe.communicate(timeout=15)
        assert probe.returncode == 0, (stdout.decode(), stderr.decode())
        assert b"owned groups stopped; handlers restored" in stdout
    finally:
        # This independent ledger permits cleanup even when the pre-fix probe
        # dies before terminating or waiting for its own groups.
        owned = json.loads(ledger.read_text()) if ledger.exists() else []
        for pid in [probe.pid, *(child["pid"] for child in owned)]:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)
        probe.wait(timeout=5)
        if probe.stdout:
            probe.stdout.close()
        if probe.stderr:
            probe.stderr.close()
