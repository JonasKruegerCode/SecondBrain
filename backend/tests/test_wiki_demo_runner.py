"""Process-supervision contract for the two-service demo launcher."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import runpy
import shutil
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


@pytest.mark.parametrize("extra", [
    ["--first-start"],
    ["--browser-engine", "webkit"],
    ["--webkit-workers"],
    ["--webkit-first-install-diagnostic"],
    ["--browser-grep", "scale"],
    ["--browser-grep", ""],
    ["--repeat-each", "2"],
])
def test_scale_rejects_mixed_or_partial_profiles_before_startup(
    extra: list[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = cast(Callable[..., int], acceptance_runner()["main"])
    monkeypatch.setitem(main.__globals__, "__file__", str(tmp_path / "scripts" / "run.py"))
    processes = MagicMock()
    monkeypatch.setitem(main.__globals__, "subprocess", processes)
    with pytest.raises(SystemExit) as error:
        main(["--scale", *extra])
    assert error.value.code == 2
    processes.Popen.assert_not_called()
    processes.run.assert_not_called()
    assert not (tmp_path / ".demo").exists()


@pytest.mark.parametrize("browser_exit, keep", [(0, False), (0, True), (7, False)])
def test_scale_command_evidence_and_owned_cleanup_without_launching_a_browser(
    browser_exit: int, keep: bool, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = cast(Callable[..., int], acceptance_runner()["main"])
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(tmp_path / "scripts" / "run.py"))
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-key-must-not-reach-services")
    supervisor = MagicMock(pid=4321)

    def start(command: list[str], **kwargs: Any) -> Any:
        vault = Path(command[command.index("--vault") + 1])
        assert not vault.exists()
        vault.mkdir()
        (vault / "owned-fixture").touch()
        Path(command[command.index("--process-state") + 1]).write_text("owned record")
        return supervisor

    def run(command: list[str], **kwargs: Any) -> Any:
        return MagicMock(
            returncode=0 if command[0] == "git" else browser_exit,
            stdout="synthetic-head",
        )

    processes = MagicMock()
    processes.Popen.side_effect = start
    processes.run.side_effect = run
    processes.TimeoutExpired = subprocess.TimeoutExpired
    monkeypatch.setitem(namespace, "subprocess", processes)
    readiness = MagicMock()
    cleanup = MagicMock()
    monkeypatch.setitem(namespace, "_wait_for_http", readiness)
    monkeypatch.setitem(namespace, "_stop_process_group", cleanup)
    assert main(["--scale", *(["--keep-vault"] if keep else [])]) == (
        0 if browser_exit == 0 else 1
    )

    results = list((tmp_path / ".demo" / "acceptance").glob("*/result.json"))
    assert len(results) == 1
    artifact_dir = results[0].parent
    processes.Popen.assert_called_once()
    assert processes.Popen.call_args.args[0] == [
        sys.executable, str(tmp_path / "scripts" / "run-wiki-demo.py"),
        "--vault", str(artifact_dir / "vault"), "--scale-pages", "320",
        "--process-state", str(artifact_dir / "processes-scale.json"),
    ]
    assert processes.Popen.call_args.kwargs["start_new_session"] is True
    browser_calls = [call for call in processes.run.call_args_list if call.args[0][0] != "git"]
    assert len(browser_calls) == 1
    assert browser_calls[0].args[0] == [
        "npm", "run", "test:browser", "--", "e2e/scale.spec.ts",
        "--output", str(artifact_dir / "browser-scale"),
    ]
    assert browser_calls[0].kwargs["cwd"] == tmp_path / "frontend"
    for call in [processes.Popen.call_args, browser_calls[0]]:
        assert call.kwargs["env"]["PLAYWRIGHT_SCALE"] == "1"
        assert call.kwargs["env"]["PLAYWRIGHT_BROWSER_ENGINE"] == "chromium"
        assert call.kwargs["env"]["PLAYWRIGHT_FIRST_START_PHASE"] == "scale"
        assert "OPENROUTER_API_KEY" not in call.kwargs["env"]
    assert readiness.call_count == 2
    cleanup.assert_called_once_with(supervisor, artifact_dir / "processes-scale.json")
    evidence = json.loads(results[0].read_text())
    assert evidence["status"] == ("passed" if browser_exit == 0 else "failed")
    assert evidence["browser_profile"] == "scale"
    assert evidence["fixture"] == "synthetic-scale-320"
    assert evidence["suites"] == ["frontend/e2e/scale.spec.ts"]
    assert evidence["test_selection"] == {"grep": None, "repeat_each": 1}
    assert evidence["browser_phases"] == [
        {"phase": "scale", "exit_code": browser_exit, "supervisor_pid": 4321},
    ]
    assert evidence["service_restarts"] == 0
    assert evidence["service_cleanup_ok"] is True
    retained = keep or browser_exit != 0
    assert evidence["vault_retained"] is retained
    assert evidence["process_records_retained"] is retained
    assert evidence["phase_inputs_retained"] is False
    assert (artifact_dir / "vault" / "owned-fixture").exists() is retained
    assert (artifact_dir / "processes-scale.json").exists() is retained


@pytest.mark.parametrize("engine, profile, service_workers, suites", [
    ("chromium", "full", "allow", [
        "e2e/wiki.spec.ts", "e2e/pwa-existing-install.spec.ts",
        "e2e/history.spec.ts", "e2e/delivery-recovery.spec.ts",
        "e2e/skip-link.spec.ts", "e2e/article-focus.spec.ts",
        "e2e/view-focus.spec.ts", "e2e/start-preference.spec.ts",
        "e2e/demo-rehearsal.spec.ts",
        "e2e/galaxy-density.spec.ts",
        "e2e/article-galaxy.spec.ts", "e2e/galaxy-search.spec.ts", "e2e/editor-retry.spec.ts",
        "e2e/resolve-identity.spec.ts",
        "e2e/markdown-lists.spec.ts",
        "e2e/code-reading.spec.ts",
        "e2e/image-reading.spec.ts",
        "e2e/unicode-navigation.spec.ts",
        "e2e/title-identity.spec.ts",
        "e2e/title-promotion.spec.ts",
        "e2e/title-inline.spec.ts",
        "e2e/inline-wrapper.spec.ts",
        "e2e/chat-concurrency.spec.ts",
        "e2e/chat-history.spec.ts",
        "e2e/forced-colors.spec.ts",
    ]),
    ("webkit", "reading-navigation", "block", [
        "e2e/skip-link.spec.ts",
        "e2e/history.spec.ts", "e2e/delivery-recovery.spec.ts",
        "e2e/article-focus.spec.ts", "e2e/view-focus.spec.ts",
        "e2e/start-preference.spec.ts",
        "e2e/demo-rehearsal.spec.ts", "e2e/galaxy-density.spec.ts",
        "e2e/article-galaxy.spec.ts", "e2e/galaxy-search.spec.ts", "e2e/editor-retry.spec.ts",
        "e2e/resolve-identity.spec.ts",
        "e2e/markdown-lists.spec.ts",
        "e2e/code-reading.spec.ts",
        "e2e/image-reading.spec.ts",
        "e2e/unicode-navigation.spec.ts",
        "e2e/title-identity.spec.ts",
        "e2e/title-promotion.spec.ts",
        "e2e/title-inline.spec.ts",
        "e2e/inline-wrapper.spec.ts",
        "e2e/chat-concurrency.spec.ts",
        "e2e/chat-history.spec.ts",
    ]),
])
@pytest.mark.parametrize("fixture_python", [None, "", "/synthetic/explicit-python"])
def test_editor_retry_orchestration_contract_without_launching_a_browser(
    engine: str, profile: str, service_workers: str, suites: list[str],
    fixture_python: str | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    if fixture_python is None:
        monkeypatch.delenv("WIKI_PYTHON", raising=False)
    else:
        monkeypatch.setenv("WIKI_PYTHON", fixture_python)
    main = cast(Callable[..., int], acceptance_runner()["main"])
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(tmp_path / "scripts" / "run.py"))
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-key-must-not-reach-services")
    supervisor = MagicMock(pid=4321)

    def start(command: list[str], **kwargs: Any) -> Any:
        vault = Path(command[command.index("--vault") + 1])
        vault.mkdir()
        (vault / "owned-fixture").touch()
        return supervisor

    processes = MagicMock()
    processes.Popen.side_effect = start
    processes.run.return_value = MagicMock(returncode=0, stdout="synthetic-head")
    processes.TimeoutExpired = subprocess.TimeoutExpired
    monkeypatch.setitem(namespace, "subprocess", processes)
    readiness = MagicMock()
    cleanup = MagicMock()
    monkeypatch.setitem(namespace, "_wait_for_http", readiness)
    monkeypatch.setitem(namespace, "_stop_process_group", cleanup)
    assert main(["--browser-engine", engine]) == 0

    results = list((tmp_path / ".demo" / "acceptance").glob("*/result.json"))
    assert len(results) == 1
    artifact_dir = results[0].parent
    browser_calls = [call for call in processes.run.call_args_list if call.args[0][0] != "git"]
    assert len(browser_calls) == 1
    expected_command = ["npm", "run", "test:browser", "--", *suites]
    expected_command.extend(["--output", str(artifact_dir / f"browser-{engine}")])
    assert browser_calls[0].args[0] == expected_command
    assert browser_calls[0].args[0].count("e2e/editor-retry.spec.ts") == 1
    assert browser_calls[0].kwargs["cwd"] == tmp_path / "frontend"
    assert browser_calls[0].kwargs["env"]["PLAYWRIGHT_BROWSER_ENGINE"] == engine
    expected_python = fixture_python or sys.executable
    assert browser_calls[0].kwargs["env"]["WIKI_PYTHON"] == expected_python
    assert processes.Popen.call_args.kwargs["env"]["WIKI_PYTHON"] == expected_python
    assert "OPENROUTER_API_KEY" not in browser_calls[0].kwargs["env"]
    processes.Popen.assert_called_once()
    assert processes.Popen.call_args.kwargs["env"]["PLAYWRIGHT_BROWSER_ENGINE"] == engine
    assert "OPENROUTER_API_KEY" not in processes.Popen.call_args.kwargs["env"]
    assert readiness.call_count == 2
    cleanup.assert_called_once_with(supervisor, artifact_dir / "processes-demo.json")

    evidence = json.loads(results[0].read_text())
    assert evidence["browser_engine"] == engine
    assert evidence["browser_profile"] == profile
    assert evidence["service_workers"] == service_workers
    assert evidence["suite"] == f"frontend/{suites[0]}"
    assert evidence["suites"] == [f"frontend/{suite}" for suite in suites]
    assert evidence["suites"].count("frontend/e2e/editor-retry.spec.ts") == 1
    assert evidence["test_selection"] == {"grep": None, "repeat_each": 1}
    assert evidence["service_cleanup_ok"] is True
    assert evidence["external_model_calls"] is False
    assert evidence["vault_retained"] is False


@pytest.mark.parametrize("extra", [
    [],
    ["--browser-engine", "chromium"],
    ["--browser-engine", "webkit", "--first-start"],
    ["--browser-engine", "webkit", "--webkit-workers"],
    ["--browser-engine", "webkit", "--browser-grep", "PWA"],
    ["--browser-engine", "webkit", "--repeat-each", "0"],
    ["--browser-engine", "webkit", "--repeat-each", "21"],
])
def test_first_install_diagnostic_rejects_invalid_cli_before_startup(
    extra: list[str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = cast(Callable[..., int], acceptance_runner()["main"])
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(tmp_path / "scripts" / "run.py"))
    processes = MagicMock()
    monkeypatch.setitem(namespace, "subprocess", processes)
    with pytest.raises(SystemExit) as error:
        main(["--webkit-first-install-diagnostic", *extra])
    assert error.value.code == 2
    processes.Popen.assert_not_called()
    processes.run.assert_not_called()
    assert not (tmp_path / ".demo").exists()


@pytest.mark.parametrize("repeat", [None, 20])
@pytest.mark.parametrize("browser_exit", [0, 7])
def test_first_install_diagnostic_command_evidence_and_cleanup(
    repeat: int | None, browser_exit: int, tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = cast(Callable[..., int], acceptance_runner()["main"])
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(tmp_path / "scripts" / "run.py"))
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-key-must-not-reach-services")
    supervisor = MagicMock(pid=4321)

    def start(command: list[str], **kwargs: Any) -> Any:
        vault = Path(command[command.index("--vault") + 1])
        vault.mkdir()
        (vault / "owned-fixture").touch()
        state = Path(command[command.index("--process-state") + 1])
        state.write_text("synthetic owned process record")
        return supervisor

    def run(command: list[str], **kwargs: Any) -> Any:
        if command[0] == "git":
            return MagicMock(returncode=0, stdout="synthetic-head")
        return MagicMock(returncode=browser_exit)

    processes = MagicMock()
    processes.Popen.side_effect = start
    processes.run.side_effect = run
    processes.TimeoutExpired = subprocess.TimeoutExpired
    monkeypatch.setitem(namespace, "subprocess", processes)
    readiness = MagicMock()
    cleanup = MagicMock()
    monkeypatch.setitem(namespace, "_wait_for_http", readiness)
    monkeypatch.setitem(namespace, "_stop_process_group", cleanup)
    args = ["--browser-engine", "webkit", "--webkit-first-install-diagnostic"]
    if repeat is not None:
        args.extend(["--repeat-each", str(repeat)])
    assert main(args) == (0 if browser_exit == 0 else 1)

    results = list((tmp_path / ".demo" / "acceptance").glob("*/result.json"))
    assert len(results) == 1
    artifact_dir = results[0].parent
    grep = "PWA metadata registers an online-only worker without private caches$"
    expected_command = [
        "npm", "run", "test:browser", "--", "e2e/wiki.spec.ts", "--grep", grep,
    ]
    if repeat is not None:
        expected_command.extend(["--repeat-each", str(repeat)])
    expected_command.extend([
        "--output", str(artifact_dir / "browser-webkit-first-install-diagnostic"),
    ])
    browser_calls = [call for call in processes.run.call_args_list if call.args[0][0] != "git"]
    assert len(browser_calls) == 1
    assert browser_calls[0].args[0] == expected_command
    assert browser_calls[0].kwargs["cwd"] == tmp_path / "frontend"
    assert browser_calls[0].kwargs["env"]["PLAYWRIGHT_BROWSER_ENGINE"] == "webkit"
    assert "OPENROUTER_API_KEY" not in browser_calls[0].kwargs["env"]
    processes.Popen.assert_called_once()
    assert "--empty" not in processes.Popen.call_args.args[0]
    assert "OPENROUTER_API_KEY" not in processes.Popen.call_args.kwargs["env"]
    assert readiness.call_count == 2
    cleanup.assert_called_once_with(supervisor, artifact_dir / "processes-demo.json")

    evidence = json.loads(results[0].read_text())
    assert evidence["status"] == ("passed" if browser_exit == 0 else "failed")
    assert evidence["browser_engine"] == "webkit"
    assert evidence["browser_profile"] == "first-install-diagnostic"
    assert evidence["service_workers"] == "allow"
    assert evidence["suite"] == "frontend/e2e/wiki.spec.ts"
    assert evidence["suites"] == ["frontend/e2e/wiki.spec.ts"]
    assert evidence["test_selection"] == {"grep": grep, "repeat_each": repeat or 1}
    assert evidence["browser_exit_code"] == browser_exit
    assert evidence["service_restarts"] == 0
    assert evidence["service_cleanup_ok"] is True
    assert evidence["external_model_calls"] is False
    assert evidence["fixture"] == "fictional-template"
    assert evidence["vault_retained"] is (browser_exit != 0)
    assert evidence["process_records_retained"] is (browser_exit != 0)
    assert (artifact_dir / "vault" / "owned-fixture").exists() is (browser_exit != 0)
    assert (artifact_dir / "processes-demo.json").exists() is (browser_exit != 0)


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


@pytest.mark.parametrize("arguments, expected_outputs", [
    ([], ["browser-chromium"]),
    (["--first-start"], ["browser-create", "browser-restart"]),
])
def test_acceptance_preserves_failed_browser_evidence_across_later_runs(
    arguments: list[str], expected_outputs: list[str],
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    main = cast(Callable[..., int], acceptance_runner()["main"])
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(tmp_path / "scripts" / "run.py"))
    supervisor = MagicMock(pid=4321)

    def start(command: list[str], **kwargs: Any) -> Any:
        vault = Path(command[command.index("--vault") + 1])
        vault.mkdir(exist_ok=True)
        (vault / "owned-fixture").touch()
        return supervisor

    outputs: list[Path] = []
    commands: list[list[str]] = []
    evidence = {
        "failed-test/error-context.md": b"Synthetic failure context: expected article title",
        "failed-test/test-failed-1.png": b"\x89PNG\r\n\x1a\nsynthetic screenshot bytes",
        "failed-test/structure.json": b'{"article":"Synthetic article","status":"failed"}',
    }

    def run(command: list[str], **kwargs: Any) -> Any:
        if command[0] == "git":
            return MagicMock(returncode=0, stdout="synthetic-head")
        commands.append(command)
        # Playwright clears its selected output directory at every invocation.
        output = (
            Path(command[command.index("--output") + 1])
            if "--output" in command
            else tmp_path / ".demo" / "browser-results"
        )
        shutil.rmtree(output, ignore_errors=True)
        output.mkdir(parents=True)
        outputs.append(output)
        if len(outputs) == 1:
            for name, content in evidence.items():
                target = output / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            return MagicMock(returncode=1)
        return MagicMock(returncode=0)

    processes = MagicMock()
    processes.Popen.side_effect = start
    processes.run.side_effect = run
    processes.TimeoutExpired = subprocess.TimeoutExpired
    monkeypatch.setitem(namespace, "subprocess", processes)
    monkeypatch.setitem(namespace, "_wait_for_http", lambda *args, **kwargs: None)
    monkeypatch.setitem(namespace, "_stop_process_group", MagicMock())

    assert main(arguments) == 1
    failed_output = outputs[0]
    assert main(arguments) == 0
    for name, content in evidence.items():
        assert (failed_output / name).read_bytes() == content
    assert len(outputs) == 1 + len(expected_outputs)
    assert len(set(outputs)) == len(outputs)
    results = list((tmp_path / ".demo" / "acceptance").glob("*/result.json"))
    assert len(results) == 2
    failed_result = next(
        path for path in results if json.loads(path.read_text())["status"] == "failed"
    )
    passed_result = next(
        path for path in results if json.loads(path.read_text())["status"] == "passed"
    )
    assert failed_output == failed_result.parent / expected_outputs[0]
    assert outputs[1:] == [passed_result.parent / name for name in expected_outputs]
    assert all(command.count("--output") == 1 for command in commands)

