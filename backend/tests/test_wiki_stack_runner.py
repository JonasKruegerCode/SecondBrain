"""Safety boundaries for the real Docker rehearsal, without pretending Docker ran."""

from __future__ import annotations

import json
import runpy
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "run-wiki-stack-acceptance.py"
runner = runpy.run_path(str(SCRIPT), run_name="wiki_stack_runner")


def config() -> dict[str, Any]:
    return {
        "services": {
            "backend": {
                "environment": {
                    "OPENROUTER_API_KEY": "must-not-survive",
                    "SECOND_BRAIN_WIKI_GIT_REMOTE": "private-remote",
                },
                "volumes": [
                    {"type": "volume", "source": "managed_wiki", "target": "/managed-vault"}
                ],
            },
            "mcp": {
                "environment": {"SECOND_BRAIN_WIKI_API_KEY": "private-key"},
                "ports": [{"published": "3001", "target": 3001}],
                "volumes": [
                    {"type": "volume", "source": "managed_wiki", "target": "/managed-vault"}
                ],
            },
            "frontend": {"ports": [{"published": "8080", "target": 80}]},
        },
        "volumes": {"managed_wiki": {"name": "existing-private-volume"}},
        "networks": {"default": {"name": "existing-private-network"}},
    }


def recovery_config() -> dict[str, Any]:
    data: dict[str, Any] = runner["isolated_config"](
        config(), "synthetic-recovery", "synthetic", restored=True
    )
    data["volumes"]["managed_wiki"] = {"external": True, "name": "synthetic-recovery"}
    for name, service in data["services"].items():
        service["image"] = "sha256:" + name
        service["pull_policy"] = "never"
    return data


@pytest.mark.parametrize(
    "danger",
    [None, "volume", "provider", "vault", "port", "proxy", "image", "mount", "pull"],
)
def test_actual_recovery_merge_rejects_wrong_targets(danger: str | None) -> None:
    data = recovery_config()
    if danger == "volume":
        data["volumes"]["managed_wiki"]["name"] = "original-live-volume"
    elif danger == "provider":
        data["services"]["backend"]["environment"]["OPENROUTER_API_KEY"] = "do-not-call"
    elif danger == "vault":
        data["services"]["mcp"]["environment"]["SECOND_BRAIN_WIKI_VAULT"] = "/managed-vault"
    elif danger == "port":
        data["services"]["frontend"]["ports"][0]["host_ip"] = "0.0.0.0"
    elif danger == "proxy":
        data["networks"]["proxy"] = {"external": True}
    elif danger == "image":
        data["services"]["frontend"]["image"] = "mutable:latest"
    elif danger == "mount":
        data["services"]["backend"]["volumes"][0]["source"] = "original"
    elif danger == "pull":
        data["services"]["mcp"]["pull_policy"] = "always"
    images = {name: "sha256:" + name for name in ("backend", "mcp", "frontend")}
    if danger is None:
        runner["validate_recovery_config"](data, "synthetic-recovery", images)
    else:
        with pytest.raises(RuntimeError):
            runner["validate_recovery_config"](data, "synthetic-recovery", images)


@pytest.mark.parametrize("foreign", [False, True])
def test_recovery_volume_cleanup_checks_ownership(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, foreign: bool
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    run.recovery_volumes["owned-recovery"] = "our-token"
    removed: list[str] = []

    def command(args: list[str], **kwargs: Any) -> str:
        if "ls" in args:
            return "owned-recovery"
        if "inspect" in args:
            return json.dumps("foreign-token" if foreign else "our-token")
        removed.append(args[-1])
        return ""

    monkeypatch.setattr(run, "command", command)
    if foreign:
        with pytest.raises(RuntimeError, match="ownership"):
            run.cleanup_recovery_volume("owned-recovery")
        assert run.recovery_volumes
        assert not removed
    else:
        run.cleanup_recovery_volume("owned-recovery")
        assert removed == ["owned-recovery"]
        assert not run.recovery_volumes


def test_existing_recovery_volume_is_not_created_or_tracked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    calls: list[list[str]] = []

    def command(args: list[str], **kwargs: Any) -> str:
        calls.append(args)
        return "existing-volume"

    monkeypatch.setattr(run, "command", command)
    with pytest.raises(RuntimeError, match="already exists"):
        run.create_recovery_volume("existing-volume")
    assert len(calls) == 1 and "ls" in calls[0]
    assert not run.recovery_volumes


@pytest.mark.parametrize("created", [False, True])
def test_recovery_create_timeout_still_tracks_and_cleans_owned_volume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, created: bool
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    creating = True
    removed: list[str] = []

    def command(args: list[str], **kwargs: Any) -> str:
        if "create" in args:
            assert run.recovery_volumes
            raise subprocess.TimeoutExpired(args, 180)
        if "ls" in args:
            return "owned-recovery" if not creating and created else ""
        if "inspect" in args:
            return json.dumps(run.recovery_volumes["owned-recovery"])
        removed.append(args[-1])
        return ""

    monkeypatch.setattr(run, "command", command)
    with pytest.raises(subprocess.TimeoutExpired):
        run.create_recovery_volume("owned-recovery")
    creating = False
    run.cleanup_recovery_volume("owned-recovery")
    assert removed == (["owned-recovery"] if created else [])
    assert not run.recovery_volumes


def test_rehearsal_replaces_inherited_credentials_ports_and_resource_names() -> None:
    original = runner["isolated_config"](config(), "synthetic-project", "synthetic-secret")
    assert original["volumes"]["managed_wiki"]["name"] == "synthetic-project_managed_wiki"
    assert original["networks"]["default"]["name"] == "synthetic-project_default"
    assert original["services"]["backend"]["ports"] == []
    for service in ("frontend", "mcp"):
        assert original["services"][service]["ports"][0]["host_ip"] == "127.0.0.1"
        assert original["services"][service]["ports"][0]["published"] == "0"
    for service in ("backend", "mcp"):
        env = original["services"][service]["environment"]
        assert env["OPENROUTER_API_KEY"] == ""
        assert env["SECOND_BRAIN_WIKI_DELIVERY"] == "0"
        assert "SECOND_BRAIN_WIKI_GIT_REMOTE" not in env
    assert "SECOND_BRAIN_WIKI_API_KEY" not in original["services"]["backend"]["environment"]
    restored = runner["isolated_config"](
        deepcopy(original), "synthetic-restore", "synthetic-secret", restored=True
    )
    assert (
        restored["volumes"]["managed_wiki"]["name"] != original["volumes"]["managed_wiki"]["name"]
    )
    for service in ("backend", "mcp"):
        assert (
            restored["services"][service]["environment"]["SECOND_BRAIN_WIKI_VAULT"]
            == "/managed-vault/restored"
        )


@pytest.mark.parametrize(
    "danger",
    ["external-volume", "external-network", "host-mount", "fixed-container", "extra-service"],
)
def test_rehearsal_refuses_nonisolated_resources(danger: str) -> None:
    data = config()
    if danger == "external-volume":
        data["volumes"]["managed_wiki"]["external"] = True
    elif danger == "external-network":
        data["networks"]["default"]["external"] = True
    elif danger == "host-mount":
        data["services"]["backend"]["volumes"][0] = {
            "type": "bind",
            "source": "/private",
            "target": "/managed-vault",
        }
    elif danger == "fixed-container":
        data["services"]["backend"]["container_name"] = "production"
    else:
        data["services"]["worker"] = {}
    with pytest.raises(RuntimeError):
        runner["isolated_config"](data, "synthetic", "synthetic")


def test_proxy_is_added_only_after_validation_and_has_no_data_or_credentials() -> None:
    isolated = runner["isolated_config"](config(), "synthetic", "synthetic-secret")
    runner["add_acceptance_proxy"](isolated)
    proxy = isolated["services"]["edge"]
    assert "volumes" not in proxy
    assert "environment" not in proxy
    assert proxy["ports"][0]["host_ip"] == "127.0.0.1"
    assert proxy["ports"][0]["published"] == "0"
    # Arbitrary extra proxy services in an inherited configuration remain refused.
    with pytest.raises(RuntimeError):
        runner["isolated_config"](isolated, "synthetic", "synthetic-secret")


def test_churn_address_uses_actual_pool_and_excludes_reserved_endpoints() -> None:
    network: dict[str, Any] = {
        "ipam": [
            {
                "Subnet": "10.91.0.0/29",
                "Gateway": "10.91.0.1",
                "AuxiliaryAddresses": {"reserved": "10.91.0.3"},
            }
        ],
        "containers": {"frontend": {"IPv4Address": "10.91.0.4/29"}},
    }
    assert runner["replacement_ip"](network, "10.91.0.2") == "10.91.0.5"
    network["ipam"][0]["IPRange"] = "10.91.0.4/30"
    assert runner["replacement_ip"](network, "10.91.0.5") == "10.91.0.6"
    network["containers"]["backend"] = {"IPv4Address": "10.91.0.6/29"}
    with pytest.raises(RuntimeError, match="no safe free"):
        runner["replacement_ip"](network, "10.91.0.5")


def test_failure_diagnostics_are_allowlisted_and_best_effort(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = runner["Run"](tmp_path, "synthetic-secret")
    commands: list[tuple[list[str], dict[str, Any]]] = []

    def command(args: list[str], **kwargs: Any) -> str:
        commands.append((args, kwargs))
        if "ps" in args:
            return "container-id"
        assert args[-2] == runner["CONTAINER_SNAPSHOT"]
        return json.dumps({"status": "running", "health": "unhealthy", "networks": {}})

    monkeypatch.setattr(run, "command", command)
    run.diagnostics(["docker", "compose"])
    output = json.loads((tmp_path / "restart-diagnostics.jsonl").read_text())
    assert output["containers"]["backend"]["health"] == "unhealthy"
    assert all(kwargs["record_output"] is False for _, kwargs in commands)
    assert all(kwargs["timeout"] == 10 for _, kwargs in commands)
    assert ".Config.Env" not in runner["CONTAINER_SNAPSHOT"]
    assert ".State.Health.Log" not in runner["CONTAINER_SNAPSHOT"]

    def failed(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("private diagnostic failure")

    monkeypatch.setattr(run, "container", failed)
    run.diagnostics([])
    assert "private diagnostic failure" not in (tmp_path / "restart-diagnostics.jsonl").read_text()


@pytest.mark.parametrize("foreign", ["container", "network", "endpoint"])
def test_churn_refuses_foreign_ownership_before_mutating(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, foreign: str
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    project = "sb-acceptance-test"

    def container(compose: list[str], service: str) -> dict[str, Any]:
        return {
            "id": service,
            "project": "production" if foreign == "container" else project,
            "service": service,
            "networks": {"owned": {"IPAddress": "10.91.0.2"}},
        }

    monkeypatch.setattr(run, "container", container)
    commands: list[list[str]] = []

    def command(args: list[str], **kwargs: Any) -> str:
        commands.append(args)
        if "network" in args:
            return json.dumps(
                {
                    "project": "production" if foreign == "network" else project,
                    "driver": "bridge",
                    "containers": {"member": {}},
                    "ipam": [],
                }
            )
        return json.dumps({"project": "production"})

    monkeypatch.setattr(run, "command", command)
    with pytest.raises(RuntimeError):
        run.exercise_dns_churn(["docker", "compose", "-p", project], "http://localhost", {}, {}, {})
    assert not any("disconnect" in args or "connect" in args for args in commands)


def test_wait_preserves_safe_last_http_status(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    clock = iter([0, 0, 2])
    monkeypatch.setattr(runner["time"], "monotonic", lambda: next(clock))
    monkeypatch.setattr(runner["time"], "sleep", lambda _: None)

    def http(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("HTTP status 502, expected 200")

    monkeypatch.setattr(run, "http", http)
    with pytest.raises(RuntimeError, match="last failure: HTTP status 502, expected 200"):
        run.wait("http://private.invalid/secret", timeout=1)


@pytest.mark.parametrize("foreign", [False, True])
def test_churn_subnet_uses_docker_selection_and_removes_probe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, foreign: bool
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    project = "sb-acceptance-subnet-test"
    commands: list[list[str]] = []

    def command(args: list[str], **kwargs: Any) -> str:
        commands.append(args)
        if "ls" in args:
            return "probe-id"
        if "inspect" in args:
            return json.dumps(
                {
                    "project": "production" if foreign else project,
                    "probe_owner": run.probe_owners[project + "-subnet-probe"][1],
                    "containers": {},
                    "ipam": [{"Subnet": "10.92.0.0/24", "Gateway": "10.92.0.1"}],
                }
            )
        return ""

    monkeypatch.setattr(run, "command", command)
    data = runner["isolated_config"](config(), project, "synthetic")
    if foreign:
        with pytest.raises(RuntimeError, match="ownership"):
            run.configure_churn_network(data, project)
        assert "ipam" not in data["networks"]["default"]
    else:
        run.configure_churn_network(data, project)
        assert data["networks"]["default"]["ipam"]["config"] == [
            {"subnet": "10.92.0.0/24", "gateway": "10.92.0.1"}
        ]
        restored = runner["isolated_config"](data, project + "-restore", "synthetic", restored=True)
        assert "ipam" not in restored["networks"]["default"]
    assert any("rm" in command for command in commands) is not foreign
    assert run.probe_networks == ([project + "-subnet-probe"] if foreign else [])


@pytest.mark.parametrize("created", [False, True])
def test_probe_creation_timeout_is_tracked_and_cleaned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, created: bool
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    project = "sb-acceptance-timeout"
    removed: list[str] = []

    def command(args: list[str], **kwargs: Any) -> str:
        if "create" in args:
            assert run.probe_networks == [project + "-subnet-probe"]
            raise subprocess.TimeoutExpired(args, 10)
        if "ls" in args:
            return "created-id" if created else ""
        if "inspect" in args:
            return json.dumps(
                {
                    "project": project,
                    "containers": {},
                    "probe_owner": run.probe_owners[project + "-subnet-probe"][1],
                }
            )
        removed.append(args[-1])
        return ""

    monkeypatch.setattr(run, "command", command)
    with pytest.raises(subprocess.TimeoutExpired):
        run.configure_churn_network(config(), project)
    assert removed == (["created-id"] if created else [])
    assert run.probe_networks == []


@pytest.mark.parametrize("refusal", ["project", "token", "attached", "removal"])
def test_probe_cleanup_refuses_foreign_resources_and_retries_owned_removal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, refusal: str
) -> None:
    run = runner["Run"](tmp_path, "synthetic")
    project = "sb-acceptance-retry"
    name = project + "-subnet-probe"
    attempts: list[str] = []
    retry = False

    def command(args: list[str], **kwargs: Any) -> str:
        if "create" in args:
            raise RuntimeError("primary creation failure")
        if "ls" in args:
            return "owned-id"
        if "inspect" in args:
            return json.dumps(
                {
                    "project": "foreign" if refusal == "project" else project,
                    "probe_owner": "foreign" if refusal == "token" else run.probe_owners[name][1],
                    "containers": {"attached": {}} if refusal == "attached" else {},
                }
            )
        attempts.append(args[-1])
        if not retry:
            raise RuntimeError("removal failed")
        return ""

    monkeypatch.setattr(run, "command", command)
    with pytest.raises(RuntimeError, match="primary creation failure"):
        run.configure_churn_network(config(), project)
    assert run.probe_networks == [name]
    if refusal == "removal":
        retry = True
        run.cleanup_probe_network(name)
        assert attempts == ["owned-id", "owned-id"]
        assert run.probe_networks == []
    else:
        assert attempts == []
        with pytest.raises(RuntimeError, match="ownership"):
            run.cleanup_probe_network(name)
