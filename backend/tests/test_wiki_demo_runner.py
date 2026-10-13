"""Process-supervision contract for the two-service demo launcher."""

from __future__ import annotations

import asyncio
import json
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
