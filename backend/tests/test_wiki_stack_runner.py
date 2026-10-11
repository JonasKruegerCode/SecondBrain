"""Safety boundaries for the real Docker rehearsal, without pretending Docker ran."""

from __future__ import annotations

import runpy
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
