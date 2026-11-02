"""Demo opt-in honors the API child's existing dotenv configuration, without keys in output."""

from __future__ import annotations

import runpy
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def launch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, dict[str, Any]]:
    script = Path(__file__).resolve().parents[2] / "scripts/run-wiki-demo.py"
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("DEFAULT_MODEL", raising=False)
    monkeypatch.chdir(tmp_path)
    root = tmp_path / "project"
    (root / "frontend/node_modules").mkdir(parents=True)
    main = runpy.run_path(str(script), run_name="demo_dotenv_test")["main"]
    namespace = main.__globals__
    monkeypatch.setitem(namespace, "__file__", str(root / "scripts/run.py"))
    processes = MagicMock()
    processes.Popen.side_effect = [MagicMock(pid=111), MagicMock(pid=222)]
    monkeypatch.setitem(namespace, "subprocess", processes)
    monkeypatch.setitem(namespace, "signal", MagicMock())
    monkeypatch.setitem(namespace, "_wait_for_children", MagicMock(return_value=0))
    monkeypatch.setitem(namespace, "_stop_children", MagicMock())
    return root, {"main": main, "namespace": namespace, "processes": processes}


def test_dotenv_only_key_permits_opted_in_start_and_preserves_model(
    launch: tuple[Path, dict[str, Any]], capsys: pytest.CaptureFixture[str]
) -> None:
    from second_brain.core.config import Settings

    root, fixture = launch
    key = "synthetic-dotenv-key"
    (root / ".env").write_text(f"OPENROUTER_API_KEY={key}\nDEFAULT_MODEL=synthetic/model\n")
    assert fixture["main"](["--empty", "--vault", str(root / "vault"), "--with-openrouter"]) == 0
    calls = fixture["processes"].Popen.call_args_list
    assert len(calls) == 2
    assert calls[0].kwargs["cwd"] == root
    assert calls[1].kwargs["cwd"] == root / "frontend"
    for call in calls:
        assert "OPENROUTER_API_KEY" not in call.kwargs["env"]
        assert "DEFAULT_MODEL" not in call.kwargs["env"]
    resolved = Settings(_env_file=[root / ".env", root.parent / ".env"])
    assert key == resolved.OPENROUTER_API_KEY
    assert resolved.DEFAULT_MODEL == "synthetic/model"
    output = capsys.readouterr()
    assert key not in output.out + output.err


def test_parent_dotenv_and_explicit_environment_precedence(
    launch: tuple[Path, dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    root, fixture = launch
    (root / ".env").write_text("OPENROUTER_API_KEY=synthetic-root\n")
    (root.parent / ".env").write_text("OPENROUTER_API_KEY=\n")
    has_key = fixture["namespace"]["_has_openrouter_key"]
    assert has_key(root) is False
    monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-environment")
    assert has_key(root) is True
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    assert has_key(root) is False


@pytest.mark.parametrize("dotenv", [False, True])
def test_no_opt_in_keeps_inherited_credentials_disabled(
    launch: tuple[Path, dict[str, Any]], monkeypatch: pytest.MonkeyPatch, dotenv: bool
) -> None:
    root, fixture = launch
    if dotenv:
        (root / ".env").write_text("OPENROUTER_API_KEY=synthetic-file\n")
    else:
        monkeypatch.setenv("OPENROUTER_API_KEY", "synthetic-environment")
    unused = MagicMock(side_effect=AssertionError("No opt-in must not resolve provider settings"))
    monkeypatch.setitem(fixture["namespace"], "_has_openrouter_key", unused)
    assert fixture["main"](["--empty", "--vault", str(root / "vault")]) == 0
    for call in fixture["processes"].Popen.call_args_list:
        assert call.kwargs["env"]["OPENROUTER_API_KEY"] == ""
    unused.assert_not_called()


def test_missing_opted_in_key_fails_before_vault_or_process_creation(
    launch: tuple[Path, dict[str, Any]], capsys: pytest.CaptureFixture[str]
) -> None:
    root, fixture = launch
    with pytest.raises(SystemExit) as error:
        fixture["main"](["--with-openrouter", "--vault", str(root / "vault")])
    assert error.value.code == 2
    fixture["processes"].Popen.assert_not_called()
    assert not (root / "vault").exists()
    assert "requires OPENROUTER_API_KEY" in capsys.readouterr().err
