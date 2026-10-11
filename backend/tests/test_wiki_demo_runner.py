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
