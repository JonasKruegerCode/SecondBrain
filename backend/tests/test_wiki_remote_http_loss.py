"""Real smart-HTTP reply loss with disposable Git data and fresh client processes."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import pytest

from second_brain.wiki.store import WikiStore

CLIENT = """
import json, sys
from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiStore, WikiError
store = WikiStore(sys.argv[1])
sync = ManagedGitSync(store, sys.argv[2], 'wiki', 'notes')
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
    root: Path, remote: Path, *, before_receive: bool
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
            dropping = receiving and counts["drops"] == 0
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


@pytest.mark.parametrize("move", ["before-receive", "unchanged", "descendant", "foreign"])
def test_lost_http_reply_recovers_prepared_publication(tmp_path: Path, move: str) -> None:
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
        result = client(store.path, url, base)
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
