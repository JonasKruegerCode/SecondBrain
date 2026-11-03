"""Real smart-HTTP reply loss with disposable Git data and fresh client processes."""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from second_brain.wiki.store import WikiStore

CLIENT = """
import json, sys, time
from pathlib import Path
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiStore, WikiError
store = WikiStore(sys.argv[1])
sync = ManagedGitSync(store, sys.argv[2], 'wiki', 'notes')
if len(sys.argv) == 5:
    gate = Path(sys.argv[4])
    gate.with_suffix('.ready').touch()
    deadline = time.monotonic() + 10
    while not gate.exists():
        if time.monotonic() > deadline:
            raise RuntimeError('Client start gate timed out')
        time.sleep(.01)
try:
    output = {'ok': True, 'receipt': sync.push(sys.argv[3], None, 'publication')}
except WikiError as error:
    output = {'ok': False, 'code': error.code}
print(json.dumps(output))
"""


def git(repo: Path, *args: str, data: bytes | None = None) -> str:
    result = subprocess.run(
        ["git", "--git-dir", str(repo), *args], input=data, capture_output=True,
        check=True, timeout=15,
        env=dict(
            os.environ, GIT_AUTHOR_NAME="Synthetic", GIT_AUTHOR_EMAIL="synthetic@localhost",
            GIT_COMMITTER_NAME="Synthetic", GIT_COMMITTER_EMAIL="synthetic@localhost",
        ),
    )
    return result.stdout.decode().strip()


@contextmanager
def lossy_remote(
    root: Path, remote: Path, *, before_receive: bool, drop_first: bool = True
) -> Iterator[tuple[str, dict[str, int]]]:
    counts = {"posts": 0, "drops": 0, "received": 0}
    failures: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            self.serve()

        def do_POST(self) -> None:
            self.serve()

        def serve(self) -> None:
            try:
                self.respond()
            except Exception as error:
                failures.append(repr(error))
                self.close_connection = True

        def respond(self) -> None:
            parsed = urlsplit(self.path)
            receiving = parsed.path.endswith("/git-receive-pack")
            data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if receiving:
                counts["posts"] += 1
            dropping = drop_first and receiving and counts["drops"] == 0
            if not (dropping and before_receive):
                result = subprocess.run(
                    ["git", "http-backend"], input=data, capture_output=True, timeout=15,
                    env=dict(
                        os.environ, GIT_PROJECT_ROOT=str(root), GIT_HTTP_EXPORT_ALL="1",
                        PATH_INFO=parsed.path, QUERY_STRING=parsed.query,
                        REQUEST_METHOD=self.command, CONTENT_LENGTH=str(len(data)),
                        CONTENT_TYPE=self.headers.get("Content-Type", ""),
                        REMOTE_USER="synthetic", REMOTE_ADDR="127.0.0.1",
                        SERVER_PROTOCOL="HTTP/1.1",
                    ),
                )
                assert result.returncode == 0, result.stderr.decode()
                if receiving:
                    counts["received"] += 1
                    assert git(remote, "rev-parse", "refs/heads/wiki")
                headers, body = result.stdout.split(b"\r\n\r\n", 1)
            if dropping:
                counts["drops"] += 1
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            fields = [line.decode().split(":", 1) for line in headers.split(b"\r\n")]
            status = next(
                (int(value.strip().split()[0]) for key, value in fields if key == "Status"), 200,
            )
            self.send_response(status)
            for key, value in fields:
                if key != "Status":
                    self.send_header(key, value.strip())
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_port
    try:
        yield f"http://127.0.0.1:{port}/remote.git", counts
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive()
        assert not failures, failures
        with socket.socket() as probe:
            assert probe.connect_ex(("127.0.0.1", port)) != 0


def client(vault: Path, url: str, base: str) -> dict[str, Any]:
    # Reopen the real prepared-object/receipt stores in a new Python process.
    result = subprocess.run(
        [sys.executable, "-c", CLIENT, str(vault), url, base],
        text=True, capture_output=True, check=True, timeout=25,
        env=dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src")),
    )
    output: dict[str, Any] = json.loads(result.stdout)
    return output


def concurrent_clients(vault: Path, url: str, base: str) -> list[dict[str, Any]]:
    # Both independent clients reopen durable state before either enters push.
    # The product's SQLite transaction, rather than this gate, owns serialization.
    gates = [vault.parent / f"retry-{index}" for index in range(2)]
    processes: list[subprocess.Popen[str]] = []
    try:
        for gate in gates:
            processes.append(subprocess.Popen(
                [sys.executable, "-c", CLIENT, str(vault), url, base, str(gate)],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src")),
            ))
        deadline = time.monotonic() + 10
        while not all(gate.with_suffix(".ready").exists() for gate in gates):
            assert all(process.poll() is None for process in processes), "Client exited before gate"
            assert time.monotonic() < deadline, "Clients did not reach the start gate"
            time.sleep(.01)
        for gate in gates:
            gate.touch()
        results = []
        for process in processes:
            stdout, stderr = process.communicate(timeout=25)
            assert process.returncode == 0, stderr
            results.append(json.loads(stdout))
        return results
    finally:
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


@pytest.mark.parametrize("concurrent", [False, True])
@pytest.mark.parametrize("move", ["before-receive", "unchanged", "descendant", "foreign"])
def test_lost_http_reply_recovers_prepared_publication(
    tmp_path: Path, move: str, concurrent: bool
) -> None:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    git(remote, "config", "http.receivepack", "true")
    store = WikiStore(tmp_path / "vault")
    store.save_page("Alpha", "# Alpha\nSynthetic transport evidence.", None, "create")
    base = store._head()
    with lossy_remote(tmp_path, remote, before_receive=move == "before-receive") as (url, counts):
        assert client(store.path, url, base) == {"ok": False, "code": "remote_unavailable"}
        assert counts == {"posts": 1, "drops": 1, "received": int(move != "before-receive")}
        published = observed = ""
        if move == "before-receive":
            assert not git(remote, "for-each-ref", "--format=%(objectname)", "refs/heads/wiki")
        else:
            published = observed = git(remote, "rev-parse", "refs/heads/wiki")
            assert git(remote, "rev-list", "--count", published) == "1"
            if move in {"descendant", "foreign"}:
                tree = git(remote, "rev-parse", published + "^{tree}")
                parents = ["-p", published] if move == "descendant" else []
                observed = git(remote, "commit-tree", tree, *parents, data=b"Independent change\n")
                git(remote, "update-ref", "refs/heads/wiki", observed)
        # A retry must use its frozen snapshot, not this later local content.
        store.save_page("Beta", "# Beta\nNot part of the prepared snapshot.", None, "later")
        later = store._head()
        results = (
            concurrent_clients(store.path, url, base) if concurrent
            else [client(store.path, url, base)]
        )
        result = results[0]
        assert all(item == result for item in results)
        if move == "foreign":
            assert result == {"ok": False, "code": "remote_conflict"}
            assert counts["posts"] == 1
            assert git(remote, "rev-parse", "refs/heads/wiki") == observed
        else:
            assert result["ok"] is True
            receipt = result["receipt"]
            if move == "before-receive":
                published = observed = receipt["published_revision"]
            assert receipt["published_revision"] == published
            assert receipt["last_verified_remote_revision"] == observed
            assert git(remote, "rev-parse", "refs/heads/wiki") == observed
            assert git(remote, "ls-tree", "-r", "--name-only", observed) == "notes/Alpha.md"
            assert counts["posts"] == (2 if move == "before-receive" else 1)
            assert counts["received"] == 1
            before_replay = dict(counts)
            assert client(store.path, url, base) == result
            assert counts == before_replay
        assert store._head() == later
        git(remote, "fsck", "--full")


@pytest.mark.skipif(os.name != "posix", reason="Hard process termination requires POSIX signals")
@pytest.mark.parametrize("boundary,move", [
    ("_push", "unchanged"), ("_ack", "unchanged"),
    ("_ack", "descendant"), ("_ack", "foreign"),
])
def test_hard_client_exit_recovers_prepared_http_publication(
    tmp_path: Path, boundary: str, move: str
) -> None:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    git(remote, "config", "http.receivepack", "true")
    store = WikiStore(tmp_path / "vault")
    store.save_page("Alpha", "# Alpha\nSynthetic hard-exit evidence.", None, "create")
    base = store._head()
    marker = tmp_path / "client-at-boundary"
    # Pause the real interpreter at a function entry; replace no product method.
    # _push starts after preparation is committed, _ack after Git is reaped.
    crashing = CLIENT.replace("try:\n", """
def pause(frame, event, arg):
    if event == 'call' and frame.f_code.co_name == sys.argv[5]:
        marker = Path(sys.argv[4])
        pending = marker.with_suffix(".tmp")
        pending.write_text(frame.f_code.co_filename)
        pending.replace(marker)
        while True:
            time.sleep(.01)
sys.setprofile(pause)
try:
""", 1)
    with lossy_remote(tmp_path, remote, before_receive=False, drop_first=False) as (url, counts):
        process = subprocess.Popen(
            [sys.executable, "-c", crashing, str(store.path), url, base, str(marker), boundary],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1] / "src")),
        )
        try:
            deadline = time.monotonic() + 10
            while not marker.exists():
                assert process.poll() is None, "Client exited before crash boundary"
                assert time.monotonic() < deadline, "Client did not reach crash boundary"
                time.sleep(.01)
            assert marker.read_text().endswith("second_brain/wiki/remote.py")
            with sqlite3.connect(store.path / ".wiki-remote.sqlite3") as db:
                commit, receipt = db.execute(
                    "SELECT commit_id, result FROM requests WHERE id='publication'"
                ).fetchone()
                assert receipt is None
            process.kill()
            stdout, stderr = process.communicate(timeout=5)
            assert process.returncode == -9, (stdout, stderr)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        published = observed = ""
        if boundary == "_push":
            assert counts["posts"] == 0
            assert not git(remote, "for-each-ref", "--format=%(objectname)", "refs/heads/wiki")
        else:
            published = observed = git(remote, "rev-parse", "refs/heads/wiki")
            assert published == commit
            assert counts == {"posts": 1, "drops": 0, "received": 1}
            if move != "unchanged":
                tree = git(remote, "rev-parse", published + "^{tree}")
                parents = ["-p", published] if move == "descendant" else []
                observed = git(remote, "commit-tree", tree, *parents, data=b"Independent change\n")
                git(remote, "update-ref", "refs/heads/wiki", observed)
        store.save_page("Beta", "# Beta\nNot part of this publication.", None, "later")
        later = store._head()
        result = client(store.path, url, base)
        if move == "foreign":
            assert result == {"ok": False, "code": "remote_conflict"}
        else:
            assert result["ok"] is True
            assert result["receipt"]["published_revision"] == commit
            assert result["receipt"]["last_verified_remote_revision"] == (observed or commit)
            assert client(store.path, url, base) == result
        assert counts == {"posts": 1, "drops": 0, "received": 1}
        assert git(remote, "rev-parse", "refs/heads/wiki") == (observed or commit)
        assert git(remote, "ls-tree", "-r", "--name-only", observed or commit) == "notes/Alpha.md"
        assert store._head() == later
        git(remote, "fsck", "--full")
