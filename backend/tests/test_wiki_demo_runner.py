"""Process-supervision contract for the two-service demo launcher."""

from __future__ import annotations

import runpy
import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast
from unittest.mock import MagicMock

import pytest


def runner() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[2] / "scripts" / "run-wiki-demo.py"
    return runpy.run_path(str(path), run_name="wiki_demo_runner")


def acceptance_runner() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[2] / "scripts" / "run-wiki-acceptance.py"
    return runpy.run_path(str(path), run_name="wiki_acceptance_runner")


def test_unexpected_service_exit_is_nonzero() -> None:
    wait = cast(Callable[..., int], runner()["_wait_for_children"])
    api = MagicMock()
    web = MagicMock()
    api.poll.side_effect = [None, 0]
    web.poll.return_value = None
    assert wait([api, web], poll_interval=0) == 1

    api.poll.side_effect = [None, 17]
    assert wait([api, web], poll_interval=0) == 17


def test_cleanup_skips_exited_processes_and_escalates_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = runner()
    stop = cast(Callable[..., None], values["_stop_children"])
    killpg = MagicMock()
    monkeypatch.setattr(values["os"], "killpg", killpg)
    api = MagicMock()
    api.poll.return_value = None
    api.wait.side_effect = subprocess.TimeoutExpired("api", 5)
    web = MagicMock()
    web.pid = 4321
    web.poll.return_value = None

    stop([api, web])

    api.terminate.assert_called_once_with()
    api.kill.assert_called_once_with()
    killpg.assert_called_once_with(4321, values["signal"].SIGTERM)
    web.wait.assert_called_once_with(timeout=5)

    exited = MagicMock()
    exited.poll.return_value = 0
    stop([exited])
    exited.terminate.assert_not_called()
    exited.wait.assert_called_once_with(timeout=5)


def test_acceptance_waits_for_http_without_environment_proxy() -> None:
    wait = cast(Callable[..., None], acceptance_runner()["_wait_for_http"])
    process = MagicMock()
    process.poll.return_value = None
    response = MagicMock()
    response.status = 200
    opener = MagicMock()
    opener.open.return_value.__enter__.return_value = response

    wait("http://127.0.0.1:8000/health", process, timeout=1, opener=opener)

    opener.open.assert_called_once_with("http://127.0.0.1:8000/health", timeout=2)


def test_acceptance_stops_if_supervised_services_exit() -> None:
    wait = cast(Callable[..., None], acceptance_runner()["_wait_for_http"])
    process = MagicMock()
    process.poll.return_value = 17

    with pytest.raises(RuntimeError, match="services exited with status 17"):
        wait("http://127.0.0.1:8000/health", process, timeout=1)
