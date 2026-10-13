"""Process-supervision contract for the two-service demo launcher."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import runpy
import signal
import socket
import subprocess
import sys
import time
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


def openrouter_acceptance_runner() -> dict[str, Any]:
    path = Path(__file__).resolve().parents[2] / "scripts" / "run-wiki-openrouter-acceptance.py"
    return runpy.run_path(str(path), run_name="wiki_openrouter_acceptance_runner")


def test_unexpected_service_exit_is_nonzero() -> None:
    wait = cast(Callable[..., int], runner()["_wait_for_children"])
    api = MagicMock()
    web = MagicMock()
    api.poll.side_effect = [None, 0]
    web.poll.return_value = None
    assert wait([api, web], poll_interval=0) == 1

    api.poll.side_effect = [None, 17]
    assert wait([api, web], poll_interval=0) == 17


def test_cleanup_signals_exited_groups_escalates_and_reaps(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = runner()
    stop = cast(Callable[..., None], values["_stop_children"])
    killpg = MagicMock()
    monkeypatch.setattr(values["os"], "killpg", killpg)
    api = MagicMock()
    api.poll.return_value = None
    api.pid = 1234
    api.wait.side_effect = [subprocess.TimeoutExpired("api", 5), None]
    web = MagicMock()
    web.pid = 4321
    web.poll.return_value = None

    stop([api, web])

    assert killpg.call_args_list == [
        ((1234, signal.SIGTERM),), ((4321, signal.SIGTERM),),
        ((1234, signal.SIGKILL),), ((4321, signal.SIGKILL),),
    ]
    assert api.wait.call_count == 2
    assert web.wait.call_count == 2

    exited = MagicMock()
    exited.pid = 8765
    exited.poll.return_value = 0
    stop([exited])
    assert killpg.call_args_list[-2:] == [
        ((8765, signal.SIGTERM),), ((8765, signal.SIGKILL),),
    ]
    assert exited.wait.call_count == 2


@pytest.mark.parametrize("leader", ["exited", "term", "ignore"])
@pytest.mark.parametrize("owner", ["demo", "acceptance"])
def test_cleanup_closes_owned_descendant_after_wrapper_exit(
    leader: str, owner: str, tmp_path: Path,
) -> None:
    stop = cast(Callable[..., None], runner()["_stop_children"])
    child_code = (
        "import socket,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
        "s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); "
        "print(s.getsockname()[1],flush=True); time.sleep(30)"
    )
    behavior = (
        "signal.signal(signal.SIGTERM,signal.SIG_IGN); " if leader == "ignore"
        else "signal.signal(signal.SIGTERM,lambda *args:sys.exit(0)); "
    )
    wrapper_code = (
        "import subprocess,sys,signal,time; " + behavior +
        f"p=subprocess.Popen([sys.executable,'-c',{child_code!r}],"
        "stdout=subprocess.PIPE,text=True); "
        "print(p.stdout.readline().strip(),flush=True); " +
        ("time.sleep(30)" if leader != "exited" else "")
    )
    wrapper = subprocess.Popen(
        [sys.executable, "-c", wrapper_code], start_new_session=True,
        stdout=subprocess.PIPE, text=True,
    )
    supervisor: subprocess.Popen[bytes] | None = None
    peer: subprocess.Popen[bytes] | None = None
    try:
        assert wrapper.stdout is not None
        port = int(wrapper.stdout.readline())
        if leader == "exited":
            wrapper.wait(timeout=5)
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
        if owner == "demo":
            stop([wrapper], grace_seconds=0.05)
        else:
            supervisor = subprocess.Popen(
                [sys.executable, "-c", "pass"], start_new_session=True,
            )
            supervisor.wait(timeout=5)
            peer = subprocess.Popen(
                [sys.executable, "-c", "pass"], start_new_session=True,
            )
            peer.wait(timeout=5)
            state = tmp_path / "processes.json"
            state.write_text(json.dumps({
                "supervisor_pid": supervisor.pid,
                "process_group_ids": [wrapper.pid, peer.pid],
                "launch_complete": True,
            }))
            cleanup = cast(Callable[..., None], acceptance_runner()["_stop_process_group"])
            cleanup(supervisor, state)
            wrapper.wait(timeout=5)
        assert wrapper.poll() is not None
        deadline = time.monotonic() + 2
        while True:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    pass
            except OSError:
                break
            assert time.monotonic() < deadline, "Owned descendant still serves after cleanup"
            time.sleep(0.01)
    finally:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(wrapper.pid, signal.SIGKILL)
        wrapper.wait(timeout=5)
        if supervisor is not None:
            supervisor.wait(timeout=5)
        if peer is not None:
            peer.wait(timeout=5)
        if wrapper.stdout is not None:
            wrapper.stdout.close()


@pytest.mark.parametrize("record", [
    {"supervisor_pid": 9999, "process_group_ids": [1234], "launch_complete": True},
    {"supervisor_pid": 4321, "process_group_ids": [True], "launch_complete": True},
    {"supervisor_pid": 4321, "process_group_ids": [2**64], "launch_complete": True},
])
def test_acceptance_rejects_unowned_process_records_without_signaling_their_groups(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, record: dict[str, Any],
) -> None:
    values = acceptance_runner()
    cleanup = cast(Callable[..., None], values["_stop_process_group"])
    state = tmp_path / "processes.json"
    state.write_text(json.dumps(record))
    process = MagicMock(pid=4321, returncode=0)
    killpg = MagicMock()
    monkeypatch.setattr(values["os"], "killpg", killpg)
    with pytest.raises(RuntimeError, match="cleanup could not be confirmed"):
        cleanup(process, state)
    assert all(call.args[0] == 4321 for call in killpg.call_args_list)


@pytest.mark.parametrize("groups", [[], [1234]])
def test_acceptance_does_not_confirm_an_incomplete_launch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, groups: list[int],
) -> None:
    values = acceptance_runner()
    cleanup = cast(Callable[..., None], values["_stop_process_group"])
    state = tmp_path / "processes.json"
    state.write_text(json.dumps({
        "supervisor_pid": 4321, "process_group_ids": groups, "launch_complete": True,
    }))
    process = MagicMock(pid=4321, returncode=0)
    monkeypatch.setattr(values["os"], "killpg", MagicMock())
    with pytest.raises(RuntimeError, match="cleanup could not be confirmed"):
        cleanup(process, state)


def test_acceptance_cleanup_failure_still_writes_failed_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = acceptance_runner()
    main = cast(Callable[..., int], values["main"])
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(tmp_path / "scripts" / "run.py"))
    supervisor = MagicMock(pid=4321)

    def start(*args: Any, **kwargs: Any) -> Any:
        command = args[0]
        vault = Path(command[command.index("--vault") + 1])
        vault.mkdir()
        (vault / "owned-fixture").touch()
        return supervisor

    processes = MagicMock()
    processes.Popen.side_effect = start
    processes.run.return_value = MagicMock(returncode=0, stdout="synthetic-head")
    processes.TimeoutExpired = subprocess.TimeoutExpired
    monkeypatch.setitem(namespace, "subprocess", processes)
    monkeypatch.setitem(namespace, "_wait_for_http", lambda *args, **kwargs: None)
    monkeypatch.setitem(namespace, "_stop_process_group", MagicMock(
        side_effect=RuntimeError("synthetic cleanup failure"),
    ))
    assert main([]) == 1
    files = list((tmp_path / ".demo" / "acceptance").glob("*/result.json"))
    assert len(files) == 1
    result = json.loads(files[0].read_text())
    assert result["status"] == "failed"
    assert result["service_cleanup_ok"] is False
    assert result["vault_retained"] is True


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


def test_first_start_rejects_a_different_browser_profile_before_startup() -> None:
    main = cast(Callable[..., int], acceptance_runner()["main"])
    with pytest.raises(SystemExit) as error:
        main(["--first-start", "--browser-engine", "webkit"])
    assert error.value.code == 2


@pytest.mark.parametrize("args", [
    ["--webkit-workers"],
    ["--webkit-workers", "--browser-engine", "webkit", "--browser-grep", "PWA"],
    ["--webkit-workers", "--browser-engine", "webkit", "--repeat-each", "2"],
])
def test_worker_profile_rejects_wrong_engine_or_partial_selection(args: list[str]) -> None:
    main = cast(Callable[..., int], acceptance_runner()["main"])
    with pytest.raises(SystemExit) as error:
        main(args)
    assert error.value.code == 2


def test_openrouter_acceptance_keeps_only_structural_evidence() -> None:
    values = openrouter_acceptance_runner()
    validate = cast(Callable[..., dict[str, Any]], values["_validate_turn"])
    answer = "This is not a real forecast; several conditions changed, so tide alone is uncertain."
    result = {
        "answer": answer,
        "sources": [
            {"id": "tide-clock", "title": "Tide clock", "evidence": "read"},
            {"id": "home", "title": "Home", "evidence": "search"},
        ],
        "activity": ["Searched.", "Read."],
        "limits": {"tool_calls": 2, "max_tool_calls": 8},
    }

    summary = validate(
        result,
        required_page="tide-clock",
    )

    assert summary == {
        "answer_characters": len(answer),
        "tool_calls": 2,
        "source_ids": ["home", "tide-clock"],
        "read_source_ids": ["tide-clock"],
        "activity_entries": 2,
    }
    assert answer not in json.dumps(summary)


def test_openrouter_acceptance_requires_the_expected_read() -> None:
    values = openrouter_acceptance_runner()
    validate = cast(Callable[..., dict[str, Any]], values["_validate_turn"])
    result = {
        "answer": "Everything is certain.",
        "sources": [{"id": "home", "title": "Home", "evidence": "read"}],
        "activity": ["Read."],
        "limits": {"tool_calls": 1, "max_tool_calls": 8},
    }

    with pytest.raises(values["AcceptanceError"], match="required page tide-clock"):
        validate(result, required_page="tide-clock")


def test_openrouter_acceptance_runs_two_turns_without_mutating_fixture(tmp_path: Path) -> None:
    values = openrouter_acceptance_runner()
    seed = cast(Callable[..., dict[str, Any]], values["seed_vault"])
    run_chat = cast(Callable[..., Any], values["_run_chat"])
    seed(tmp_path)

    def tool_call(page_id: str, call_id: str) -> dict[str, Any]:
        return {
            "id": call_id,
            "type": "function",
            "function": {"name": "read_page", "arguments": json.dumps({"page_id": page_id})},
        }

    class Provider:
        def __init__(self) -> None:
            self.replies: list[dict[str, Any]] = [
                {"content": None, "tool_calls": [tool_call("tide-clock", "first-read")]},
                {
                    "content": "It is not a real forecast and must not guide real shore access.",
                    "tool_calls": [],
                },
                {"content": None, "tool_calls": [tool_call("salt-marsh", "follow-read")]},
                {
                    "content": "Several conditions changed, so the tide effect remains uncertain.",
                    "tool_calls": [],
                },
            ]
            self.requests: list[list[dict[str, Any]]] = []

        async def tool_chat(
            self,
            messages: list[dict[str, Any]],
            tools: list[dict[str, Any]],
            *,
            model: str | None = None,
            max_tokens: int = 1200,
        ) -> dict[str, Any]:
            self.requests.append(messages.copy())
            return self.replies.pop(0)

    provider = Provider()
    progress = values["Progress"]()
    result = asyncio.run(run_chat(tmp_path, lambda: provider, progress))

    assert result["first_turn"]["read_source_ids"] == ["tide-clock"]
    assert result["follow_up"]["read_source_ids"] == ["salt-marsh"]
    assert progress.provider_invocations_attempted == 4
    assert progress.provider_invocations_completed == 4
    assert progress.turns_attempted == 2
    assert progress.turns_completed == 2
    assert progress.vault_unchanged is True
    assert any(
        message.get("role") == "assistant" and "not a real forecast" in message.get("content", "")
        for message in provider.requests[2]
    )


@pytest.mark.parametrize("fail_stage", [
    "seed", "provider_init", "first_turn", "follow_up", "mutation", "cleanup", "success",
])
def test_openrouter_failure_evidence_records_only_observed_progress(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fail_stage: str,
) -> None:
    values = openrouter_acceptance_runner()
    main = cast(Callable[..., int], values["main"])
    namespace = main.__globals__
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-no-network-key")
    monkeypatch.setitem(namespace, "_artifact_dir", lambda root: tmp_path)
    seed = namespace["seed_vault"]

    class Provider:
        def __init__(self) -> None:
            if fail_stage == "provider_init":
                raise RuntimeError("sensitive provider detail")
            self.calls = 0

        async def tool_chat(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
            self.calls += 1
            if fail_stage == "mutation":
                store = values["WikiStore"](tmp_path / "vault")
                home = store.get_page("home")
                store.save_page("home", "# Synthetic changed home\n", home["revision"], "change")
                raise RuntimeError("sensitive mutation detail")
            if fail_stage == "first_turn" or fail_stage == "follow_up" and self.calls == 3:
                raise RuntimeError("sensitive provider detail")
            if self.calls in (1, 3):
                page_id = "tide-clock" if self.calls == 1 else "salt-marsh"
                return {"tool_calls": [{"id": "read", "function": {
                    "name": "read_page", "arguments": json.dumps({"page_id": page_id}),
                }}]}
            # These intentionally wrong fixture claims cannot be blessed as
            # answer quality merely because they mention the question's terms.
            return {"content": (
                "Use this real forecast for navigation and shore access. "
                "The experiment proves that tide alone caused the difference."
            )}

    async def run(vault: Path, *, progress: Any) -> dict[str, Any]:
        return cast(dict[str, Any], await values["_run_chat"](vault, Provider, progress))

    def seed_or_fail(vault: Path) -> Any:
        if fail_stage == "seed":
            raise RuntimeError("sensitive seed detail")
        return seed(vault)

    monkeypatch.setitem(namespace, "seed_vault", seed_or_fail)
    monkeypatch.setitem(namespace, "_run_chat", run)
    if fail_stage == "cleanup":
        cleanup = MagicMock()
        cleanup.rmtree.side_effect = PermissionError("sensitive cleanup detail")
        monkeypatch.setitem(namespace, "shutil", cleanup)
    assert main(["--confirm-paid-provider"]) == (0 if fail_stage == "success" else 1)
    evidence = json.loads((tmp_path / "result.json").read_text())
    expected = {
        "seed": (0, 0, 0, 0, None),
        "provider_init": (0, 0, 0, 0, True),
        "first_turn": (1, 0, 1, 0, True),
        "follow_up": (3, 2, 2, 1, True),
        "mutation": (1, 0, 1, 0, False),
        "cleanup": (4, 4, 2, 2, True),
        "success": (4, 4, 2, 2, True),
    }[fail_stage]
    assert tuple(evidence[key] for key in (
        "provider_invocations_attempted", "provider_invocations_completed",
        "turns_attempted", "turns_completed", "vault_unchanged",
    )) == expected
    assert evidence["multi_turn"] is (fail_stage in ("cleanup", "success"))
    assert evidence["acceptance_scope"] == "structural"
    assert evidence["answer_quality_reviewed"] is False
    assert evidence["vault_retained"] is (fail_stage not in ("seed", "success"))
    assert evidence["cleanup_attempted"] is (fail_stage in ("cleanup", "success"))
    assert evidence["cleanup_ok"] is (
        {"cleanup": False, "success": True}.get(fail_stage)
    )
    assert "sensitive" not in (tmp_path / "result.json").read_text()
    assert "real forecast" not in (tmp_path / "result.json").read_text()
