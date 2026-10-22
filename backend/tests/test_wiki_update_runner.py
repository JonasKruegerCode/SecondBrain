"""Guardrails for the real image transition fixture; these do not run Docker."""

from __future__ import annotations

import json
import runpy
import subprocess
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/run-wiki-update-acceptance.py"
runner = runpy.run_path(str(SCRIPT))
OLD = dict.fromkeys(runner["SERVICES"], "sha256:" + "1" * 64)
NEW = dict.fromkeys(runner["SERVICES"], "sha256:" + "2" * 64)


@pytest.mark.parametrize("bad", ["tag", "short", "missing", "service"])
def test_selected_images_refuse_mutable_or_partial_selection(bad: str) -> None:
    images = dict(OLD)
    config: dict[str, Any] = {"services": {name: {"build": "source"} for name in OLD}}
    if bad == "tag":
        images["backend"] = "mutable:latest"
    elif bad == "short":
        images["backend"] = "sha256:1234"
    elif bad == "missing":
        del images["mcp"]
    else:
        config["services"]["foreign"] = {}
    with pytest.raises(RuntimeError):
        runner["selected_config"](config, images)


def test_selection_copies_config_and_removes_build_before_start() -> None:
    config = {"services": {name: {"build": "source"} for name in OLD}}
    chosen = runner["selected_config"](config, OLD)
    assert all("build" in service for service in config["services"].values())
    assert all(
        service == {"image": OLD[name], "pull_policy": "never"}
        for name, service in chosen["services"].items()
    )


@pytest.mark.parametrize("same", ["backend", "frontend", None])
def test_same_runtime_versions_cannot_pass_as_an_upgrade(same: str | None) -> None:
    candidate = dict(NEW)
    if same is not None:
        candidate[same] = OLD[same]
        with pytest.raises(RuntimeError):
            runner["distinct_versions"](OLD, candidate)
    else:
        runner["distinct_versions"](OLD, candidate)


def test_source_check_rejects_wrong_revision_and_untracked_inputs(tmp_path: Path) -> None:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(tmp_path), *args], check=True, capture_output=True, text=True
        ).stdout.strip()

    git("init")
    git(
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "Synthetic baseline",
    )
    head = git("rev-parse", "HEAD")
    assert runner["source_revision"](tmp_path, head) == head
    with pytest.raises(RuntimeError, match="revision"):
        runner["source_revision"](tmp_path, "0" * 40)
    (tmp_path / "foreign-input").touch()
    with pytest.raises(RuntimeError, match="clean"):
        runner["source_revision"](tmp_path, head)


@pytest.mark.parametrize("wrong", ["project", "image", "mount", "owner", None])
def test_running_state_checks_actual_selection_and_ownership(wrong: str | None) -> None:
    class Probe:
        recovery_volumes = {"owned-volume": "token"}

        def container(self, compose: list[str], name: str) -> dict[str, str]:
            return {
                "id": name,
                "service": name,
                "project": "foreign" if wrong == "project" else "owned",
            }

        def command(self, args: list[str], **kwargs: Any) -> str:
            name = args[-1]
            if ".Image" in args[-2]:
                return json.dumps(NEW[name] if wrong == "image" else OLD[name])
            return json.dumps(
                []
                if name == "frontend"
                else [
                    {
                        "Name": "foreign" if wrong == "mount" else "owned-volume",
                        "Destination": "/managed-vault",
                    }
                ]
            )

        def check(self, name: str, condition: bool) -> None:
            if not condition:
                raise RuntimeError(name)

        def recovery_volume_owner(self, name: str, token: str) -> None:
            assert name == "owned-volume" and token == "token"
            if wrong == "owner":
                raise RuntimeError("foreign ownership")

    if wrong is None:
        runner["running_selection"](Probe(), [], "owned", OLD, "owned-volume")
    else:
        with pytest.raises(RuntimeError):
            runner["running_selection"](Probe(), [], "owned", OLD, "owned-volume")


def test_volume_creation_refusal_never_registers_compose_deletion(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed create must not reach down --volumes on a preexisting volume."""
    state: dict[str, Any] = {"commands": [], "create_checked": False}
    raw = {
        "services": {
            name: {
                "build": {"context": "/synthetic"},
                "volumes": [
                    {"type": "volume", "source": "managed_wiki", "target": "/managed-vault"}
                ]
                if name != "frontend"
                else [],
            }
            for name in OLD
        },
        "volumes": {"managed_wiki": {}},
        "networks": {"default": {}},
    }

    class RefusingRun:
        def __init__(self, artifact: Path, key: str) -> None:
            self.key = key
            self.steps: list[str] = []
            self.projects: list[list[str]] = []
            self.recovery_volumes: dict[str, str] = {}
            self.config = Path()

        def command(self, args: list[str], **kwargs: Any) -> str:
            state["commands"].append(args)
            if "context" in args and "inspect" in args:
                return json.dumps("unix:///synthetic")
            if "config" in args:
                return json.dumps(raw)
            if "build" in args:
                self.config = Path(args[args.index("-f") + 1])
            if "image" in args and "inspect" in args:
                return json.dumps("sha256:" + ("1" if ":old-" in args[-1] else "2") * 64)
            return ""

        def create_recovery_volume(self, name: str) -> None:
            selected = json.loads((self.config.parent / "running.json").read_text())
            assert selected["volumes"]["managed_wiki"] == {"external": True, "name": name}
            assert self.projects == []
            state["create_checked"] = True
            raise RuntimeError("preexisting volume refused")

    globals_ = runner["main"].__globals__
    monkeypatch.setitem(globals_, "ROOT", tmp_path)
    monkeypatch.setitem(globals_, "Run", RefusingRun)
    monkeypatch.setitem(globals_, "source_revision", lambda *args: "a" * 40)
    monkeypatch.setattr(globals_["signal"], "signal", lambda *args: None)
    monkeypatch.setattr(subprocess, "run", lambda *args, **kwargs: None)
    assert runner["main"](["--baseline-source", str(tmp_path / "baseline")]) == 1
    assert state["create_checked"] is True
    assert not any("down" in command for command in state["commands"])
    result = json.loads(
        next((tmp_path / ".demo/update-acceptance").glob("*/result.json")).read_text()
    )
    assert result["status"] == "failed" and result["cleanup_ok"] is True
