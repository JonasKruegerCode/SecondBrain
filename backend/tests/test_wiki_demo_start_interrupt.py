"""Real catchable startup signals; POSIX SIGKILL and Windows are out of scope."""

from __future__ import annotations

import contextlib
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

# Run the actual main in a separately owned supervisor. Only its launch command
# is substituted: every service is a real session leader with a real socket.
_SUPERVISOR = r"""
import json, os, runpy, select, signal, subprocess, sys
from pathlib import Path
script, fixture, owned_path, receipt_path, boundary, number, signum = sys.argv[1:]
number, signum = int(number), int(signum)
values = runpy.run_path(script, run_name="wiki_demo_interrupt_test")
main = values["main"]
g = main.__globals__
g["__file__"] = str(Path(fixture) / "scripts" / "run-wiki-demo.py")
real_popen = subprocess.Popen
owned = []
child_code = ("import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); "
              "s.listen(); print(s.getsockname()[1],flush=True); time.sleep(30)")
def launch(*args, **kwargs):
    child = real_popen([sys.executable, "-u", "-c", child_code],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    assert select.select([child.stdout], [], [], 5)[0], "child readiness timed out"
    port = int(child.stdout.readline())
    owned.append({"pid": child.pid, "port": port})
    Path(owned_path).write_text(json.dumps(owned))
    if boundary == "spawn" and len(owned) == number:
        os.kill(os.getpid(), signum)
    return child
original_record = g["_record_processes"]
fired = False
def record(path, children, *, complete):
    global fired
    if (boundary in ("receipt", "cleanup_repeat", "receipt_failure")
            and len(children) == number and not fired):
        fired = True
        if boundary == "receipt_failure":
            raise OSError("controlled receipt-write fixture failure")
        os.kill(os.getpid(), signum)
    original_record(path, children, complete=complete)
original_stop = g["_stop_children"]
def stop(children, **kwargs):
    if boundary == "cleanup_repeat":
        os.kill(os.getpid(), signal.SIGINT)
        os.kill(os.getpid(), signal.SIGINT)
    return original_stop(children, **kwargs)
g["_stop_children"] = stop
g["subprocess"].Popen = launch
g["_record_processes"] = record
raise SystemExit(main(["--empty", "--vault", str(Path(fixture)/"vault"),
                       "--process-state", receipt_path]))
"""


def _port_open(port: int) -> bool:
    with socket.socket() as connection:
        connection.settimeout(0.05)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def _assert_owned_supervision(
    tmp_path: Path, signum: int, boundary: str, child_number: int
) -> None:
    root = Path(__file__).resolve().parents[2]
    (tmp_path / "frontend" / "node_modules").mkdir(parents=True)
    owned_path = tmp_path / "owned.json"
    receipt_path = tmp_path / "process-state.json"
    supervisor = subprocess.Popen(
        [
            sys.executable,
            "-c",
            _SUPERVISOR,
            str(root / "scripts" / "run-wiki-demo.py"),
            str(tmp_path),
            str(owned_path),
            str(receipt_path),
            boundary,
            str(child_number),
            str(int(signum)),
        ],
        env={**os.environ, "PYTHONPATH": str(root / "backend" / "src")},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    owned: list[dict[str, int]] = []
    try:
        stdout, stderr = supervisor.communicate(timeout=10)
        owned = json.loads(owned_path.read_text()) if owned_path.exists() else []
        if boundary == "receipt_failure":
            assert supervisor.returncode != 0
            assert "controlled receipt-write fixture failure" in stderr.decode()
        else:
            assert supervisor.returncode == 0, (stdout.decode(), stderr.decode())
        assert len(owned) == child_number
        deadline = time.monotonic() + 2
        while any(_port_open(child["port"]) for child in owned) and time.monotonic() < deadline:
            time.sleep(0.025)
        assert all(not _port_open(child["port"]) for child in owned), "owned socket leaked"
        # These direct children must have been waited for, not left as zombies.
        for child in owned:
            with pytest.raises(ProcessLookupError):
                os.kill(child["pid"], 0)
        if boundary == "receipt_failure":
            return
        receipt = json.loads(receipt_path.read_text())
        assert receipt["supervisor_pid"] == supervisor.pid
        assert receipt["process_group_ids"] == [child["pid"] for child in owned]
        assert receipt["launch_complete"] is (child_number == 2)
    finally:
        # Read the independent ownership ledger even when an assertion or the
        # old launcher fails before returning its Popen object.
        if owned_path.exists():
            owned = json.loads(owned_path.read_text())
        for pid in [supervisor.pid, *(child["pid"] for child in owned)]:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(pid, signal.SIGKILL)
        supervisor.wait(timeout=10)
        if supervisor.stdout:
            supervisor.stdout.close()
        if supervisor.stderr:
            supervisor.stderr.close()


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX process groups and signals")
@pytest.mark.parametrize("signum", [signal.SIGTERM, signal.SIGINT], ids=["term", "int"])
@pytest.mark.parametrize("boundary", ["spawn", "receipt"])
@pytest.mark.parametrize("child_number", [1, 2])
def test_startup_signal_retains_and_stops_owned_children(
    tmp_path: Path, signum: int, boundary: str, child_number: int
) -> None:
    _assert_owned_supervision(tmp_path, signum, boundary, child_number)


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX process groups and signals")
@pytest.mark.parametrize("child_number", [1, 2])
def test_repeated_cleanup_signals_still_stop_and_reap_children(
    tmp_path: Path, child_number: int
) -> None:
    _assert_owned_supervision(tmp_path, signal.SIGTERM, "cleanup_repeat", child_number)


@pytest.mark.skipif(os.name != "posix", reason="requires POSIX process groups and signals")
@pytest.mark.parametrize("child_number", [1, 2])
def test_controlled_receipt_write_error_still_stops_and_reaps_children(
    tmp_path: Path, child_number: int
) -> None:
    # The fixture raises OSError at the write boundary; no disk failure is induced.
    _assert_owned_supervision(tmp_path, signal.SIGTERM, "receipt_failure", child_number)
