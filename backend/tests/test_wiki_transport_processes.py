"""Concurrent native REST/MCP requests; no provider or mutation-interleaving mocks."""

import os
import signal
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, contextmanager, suppress
from pathlib import Path
from threading import Barrier
from typing import Any, cast

import httpx
import pytest

from second_brain.wiki.store import WikiStore

KEY = "synthetic-transport-process-key"
HEADERS = {"Authorization": f"Bearer {KEY}", "Accept": "application/json, text/event-stream"}


@contextmanager
def services(root: Path, vault: Path, *, remote: Path | None = None) -> Iterator[tuple[str, str]]:
    """Own listening sockets before spawning, then stop/reap only our children."""
    source = Path(__file__).resolve().parents[1] / "src"
    env = {
        "PATH": os.environ["PATH"],
        "LANG": "C.UTF-8",
        "PYTHONPATH": str(source),
        "SECOND_BRAIN_WIKI_VAULT": str(vault),
        "SECOND_BRAIN_WIKI_API_KEY": KEY,
        "SECOND_BRAIN_WIKI_DELIVERY": "0",
        "SECOND_BRAIN_WIKI_GRAPH_INDEX": "0",
        "SECOND_BRAIN_WIKI_VECTOR_INDEX": "0",
        "OPENROUTER_API_KEY": "",
    }
    if remote is not None:
        env.update(
            SECOND_BRAIN_WIKI_DELIVERY="1",
            SECOND_BRAIN_WIKI_GIT_SYNC="1",
            SECOND_BRAIN_WIKI_GIT_REMOTE=str(remote),
            SECOND_BRAIN_WIKI_GIT_BRANCH="wiki",
            SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION="empty",
        )
    processes: list[subprocess.Popen[bytes]] = []
    urls: list[str] = []
    with ExitStack() as stack:
        try:
            for name, factory in (
                ("rest", "second_brain.wiki.api:app_factory"),
                ("mcp", "second_brain.wiki.mcp:http_app_factory"),
            ):
                listener = stack.enter_context(socket.socket())
                listener.bind(("127.0.0.1", 0))
                listener.listen(128)
                urls.append(f"http://127.0.0.1:{listener.getsockname()[1]}")
                log = stack.enter_context((root / f"{name}.log").open("ab"))
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "uvicorn",
                        factory,
                        "--factory",
                        "--fd",
                        str(listener.fileno()),
                        "--log-level",
                        "warning",
                    ],
                    env=env,
                    cwd=root,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    pass_fds=(listener.fileno(),),
                    start_new_session=True,
                )
                processes.append(process)
                listener.close()
            deadline = time.monotonic() + 15
            with httpx.Client(headers=HEADERS, trust_env=False, timeout=1) as client:
                for index, url in enumerate(urls):
                    while True:
                        assert all(p.poll() is None for p in processes), "Service exited; see logs"
                        try:
                            if index == 1:
                                initialize(client, url)
                                break
                            if client.get(url + "/api/wiki/health").status_code == 200:
                                break
                        except httpx.TransportError:
                            pass
                        assert time.monotonic() < deadline, "Service startup timed out; see logs"
                        time.sleep(0.025)
            yield urls[0], urls[1]
        finally:
            for process in processes:
                if process.poll() is None:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGTERM)
            for process in processes:
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    with suppress(ProcessLookupError):
                        os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
                assert process.poll() is not None


def rpc(client: httpx.Client, url: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
    response = client.post(
        url + "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        },
    )
    assert response.status_code == 200, response.text
    assert "no-store" in response.headers["cache-control"]
    body = response.json()
    assert "error" not in body, body
    return cast(dict[str, Any], body["result"])


def initialize(client: httpx.Client, url: str) -> None:
    result = rpc(
        client,
        url,
        "initialize",
        {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "synthetic-transport-process-test", "version": "1"},
        },
    )
    assert result["serverInfo"]["name"] == "Second Brain Managed Wiki"
    response = client.post(
        url + "/mcp",
        json={
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        },
    )
    assert response.status_code == 202


def tool(client: httpx.Client, url: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return rpc(client, url, "tools/call", {"name": name, "arguments": arguments})


def save_rest(client: httpx.Client, url: str, args: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    response = client.post(
        url + f"/api/wiki/pages/{args['id']}",
        json={key: value for key, value in args.items() if key != "id"},
    )
    assert response.status_code in {200, 409}, response.text
    assert "no-store" in response.headers["cache-control"]
    return response.status_code == 200, response.json()


def save_mcp(client: httpx.Client, url: str, args: dict[str, Any]) -> tuple[bool, dict[str, Any]]:
    result = tool(client, url, "save_page", args)
    return not result.get("isError", False), result.get("structuredContent", result)


@pytest.mark.parametrize("case", ["same-request", "competing-writes", "reused-request"])
def test_simultaneous_rest_mcp_writes_and_restart(tmp_path: Path, case: str) -> None:
    vault = tmp_path / "vault"
    store = WikiStore(vault)
    seed = store.save_page("harbor", "# Harbor\nOriginal synthetic survey.", None, "seed")
    rest_args = {
        "id": "harbor",
        "markdown": "# Harbor\nEastern synthetic survey.",
        "base_revision": seed["revision"],
        "request_id": "east",
    }
    mcp_args = {
        **rest_args,
        **({} if case == "same-request" else {"markdown": "# Harbor\nWestern survey."}),
        **({"request_id": "west"} if case == "competing-writes" else {}),
    }
    with (
        services(tmp_path, vault) as (rest_url, mcp_url),
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as rest,
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as mcp,
    ):
        denied = rest.get(rest_url + "/api/wiki/health", headers={"Authorization": ""})
        assert denied.status_code == 401
        assert mcp.post(mcp_url + "/mcp", headers={"Authorization": ""}, json={}).status_code == 401
        initialize(mcp, mcp_url)
        assert tool(mcp, mcp_url, "get_page", {"id": "harbor"})[
            "structuredContent"
        ] == store.get_page("harbor")
        barrier = Barrier(3)

        def rest_write() -> tuple[bool, dict[str, Any]]:
            barrier.wait(timeout=5)
            return save_rest(rest, rest_url, rest_args)

        def mcp_write() -> tuple[bool, dict[str, Any]]:
            barrier.wait(timeout=5)
            return save_mcp(mcp, mcp_url, mcp_args)

        # Client dispatch is synchronized; server-side CAS ordering is not prescribed.
        with ThreadPoolExecutor(max_workers=2) as pool:
            east, west = pool.submit(rest_write), pool.submit(mcp_write)
            barrier.wait(timeout=5)
            replies = [east.result(timeout=15), west.result(timeout=15)]
        if case == "same-request":
            assert all(success for success, _ in replies)
            assert replies[0][1] == replies[1][1]
        else:
            assert sum(success for success, _ in replies) == 1
            error = replies[1][1] if replies[0][0] else replies[0][1]
            if replies[0][0]:
                message = "The page changed" if case == "competing-writes" else "different payload"
                assert message in str(error)
            else:
                code = "revision_conflict" if case == "competing-writes" else "request_id_reused"
                assert error["error"] == code
        receipt = next(data for success, data in replies if success)
        winning_args = rest_args if replies[0][0] else mcp_args
        page = rest.get(rest_url + "/api/wiki/pages/harbor").json()
        assert page["markdown"] == winning_args["markdown"]
        assert page["revision"] == receipt["revision"]
        assert tool(mcp, mcp_url, "get_page", {"id": "harbor"})["structuredContent"] == page
        history = store.history("harbor")
        assert len(history) == 2 and len({row["commit"] for row in history}) == 2
        later = {
            **rest_args,
            "markdown": "# Harbor\nLater reviewed survey.",
            "base_revision": page["revision"],
            "request_id": "later",
        }
        assert save_rest(rest, rest_url, later)[0]
        published = store.snapshot()
        assert len(store.history("harbor")) == 3

    # Both factories restart from the same authority, not from exported Markdown.
    with (
        services(tmp_path, vault) as (rest_url, mcp_url),
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as rest,
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as mcp,
    ):
        initialize(mcp, mcp_url)
        assert save_rest(rest, rest_url, winning_args) == (True, receipt)
        assert save_mcp(mcp, mcp_url, winning_args) == (True, receipt)
        assert store.snapshot() == published
        page = rest.get(rest_url + "/api/wiki/pages/harbor").json()
        assert page["markdown"] == later["markdown"]
        assert tool(mcp, mcp_url, "get_page", {"id": "harbor"})["structuredContent"] == page
        history = rest.get(rest_url + "/api/wiki/pages/harbor/history").json()["history"]
        assert history == store.history("harbor")
        mcp_history = tool(mcp, mcp_url, "get_history", {"id": "harbor"})["structuredContent"]
        assert mcp_history["result"] == history


def test_git_failure_cross_transport_replay_preserves_later_write(tmp_path: Path) -> None:
    vault, remote = tmp_path / "vault", tmp_path / "remote.git"
    offline = tmp_path / "offline.git"
    subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
    remote.rename(offline)
    store = WikiStore(vault)
    args = {
        "id": "harbor",
        "markdown": "# Harbor\nSynthetic first survey.",
        "base_revision": None,
        "request_id": "delivery-first",
    }

    def wait_remote(client: httpx.Client, url: str, state: str) -> dict[str, Any]:
        deadline = time.monotonic() + 30
        while True:
            response = client.get(url + "/api/wiki/delivery-status")
            assert response.status_code == 200
            status = response.json()
            if status["remote"]["state"] == state:
                return cast(dict[str, Any], status)
            assert time.monotonic() < deadline, status
            time.sleep(0.025)

    def assert_replays_and_conflicts() -> None:
        assert save_rest(rest, rest_url, args) == (True, receipt)
        assert save_mcp(mcp, mcp_url, args) == (True, receipt)
        stale = {**args, "request_id": "fresh-stale", "base_revision": receipt["revision"]}
        success, conflict = save_rest(rest, rest_url, stale)
        assert not success
        assert conflict["error"] == "revision_conflict"
        assert conflict["current_revision"] == later_receipt["revision"]
        result = tool(mcp, mcp_url, "save_page", stale)
        assert result["isError"] is True
        assert result["structuredContent"]["error"] == "revision_conflict"
        assert result["structuredContent"]["current_revision"] == later_receipt["revision"]
        assert store.snapshot() == published
        assert rest.get(rest_url + "/api/wiki/pages/harbor").json() == page
        assert tool(mcp, mcp_url, "get_page", {"id": "harbor"})["structuredContent"] == page
        assert rest.get(rest_url + "/api/wiki/pages/harbor/history").json()["history"] == history
        assert (
            tool(mcp, mcp_url, "get_history", {"id": "harbor"})["structuredContent"]["result"]
            == history
        )

    with (
        services(tmp_path, vault, remote=remote) as (rest_url, mcp_url),
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as rest,
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as mcp,
    ):
        initialize(mcp, mcp_url)
        success, receipt = save_rest(rest, rest_url, args)
        assert success and receipt["publication"] == "saved"
        wait_remote(rest, rest_url, "error")
        assert not remote.exists()
        later = {
            **args,
            "markdown": "# Harbor\nSynthetic later reviewed survey.",
            "base_revision": receipt["revision"],
            "request_id": "delivery-later",
        }
        success, later_receipt = save_mcp(mcp, mcp_url, later)
        assert success and later_receipt["revision"] != receipt["revision"]
        published = store.snapshot()
        page, history = store.get_page("harbor"), store.history("harbor")
        assert len(history) == 2
        assert_replays_and_conflicts()
        offline.rename(remote)
        status = wait_remote(rest, rest_url, "current")
        assert status["remote"]["last_published_content_revision"] == store._head()
        assert_replays_and_conflicts()

    with (
        services(tmp_path, vault, remote=remote) as (rest_url, mcp_url),
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as rest,
        httpx.Client(headers=HEADERS, trust_env=False, timeout=10) as mcp,
    ):
        initialize(mcp, mcp_url)
        wait_remote(rest, rest_url, "current")
        assert_replays_and_conflicts()
        markdown = subprocess.check_output(
            ["git", "--git-dir", str(remote), "show", "wiki:harbor.md"]
        ).decode()
        assert markdown == later["markdown"]
