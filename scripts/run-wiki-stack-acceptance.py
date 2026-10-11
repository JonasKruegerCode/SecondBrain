"""Exercise the real managed Compose images in disposable local projects."""

from __future__ import annotations

import base64
import json
import os
import secrets
import signal
import ssl
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPSHandler, ProxyHandler, Request, build_opener
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
TOOLS = {
    "get_page",
    "list_pages",
    "search_wiki",
    "save_page",
    "delete_page",
    "get_graph",
    "get_neighbors",
    "get_history",
    "get_index_status",
    "get_delivery_status",
}


def isolated_config(
    config: dict[str, Any], project: str, key: str, *, restored: bool = False
) -> dict[str, Any]:
    """Only modify the managed preview; refuse external or host data mounts."""
    if set(config["services"]) != {"backend", "mcp", "frontend"}:
        raise RuntimeError("unexpected managed Compose services")
    for resource in ("volumes", "networks"):
        for name, value in config.get(resource, {}).items():
            if value.get("external"):
                raise RuntimeError("external Compose resource refused")
            value["name"] = f"{project}_{name}"
    config["name"] = project
    for name, service in config["services"].items():
        if service.get("container_name"):
            raise RuntimeError("fixed container name refused")
        for mount in service.get("volumes", []):
            if mount.get("type") != "volume" or mount.get("source") != "managed_wiki":
                raise RuntimeError("unexpected data mount refused")
        if name in {"backend", "mcp"}:
            service["environment"] = {
                "SECOND_BRAIN_WIKI_VAULT": "/managed-vault/restored"
                if restored
                else "/managed-vault",
                "OPENROUTER_API_KEY": "",
                "SECOND_BRAIN_WIKI_DELIVERY": "0",
                **(
                    {
                        "SECOND_BRAIN_WIKI_API_KEY": key,
                        "SECOND_BRAIN_WIKI_MCP_ALLOWED_HOSTS": "localhost,localhost:*,127.0.0.1,127.0.0.1:*",
                        "SECOND_BRAIN_WIKI_MCP_ALLOWED_ORIGINS": "http://localhost,http://localhost:*,http://127.0.0.1,http://127.0.0.1:*,https://127.0.0.1:*",
                    }
                    if name == "mcp"
                    else {}
                ),
            }
        service["restart"] = "no"
        service["ports"] = (
            []
            if name == "backend"
            else [
                {
                    "target": 3001 if name == "mcp" else 80,
                    "published": "0",
                    "host_ip": "127.0.0.1",
                    "protocol": "tcp",
                }
            ]
        )
    return config


def add_acceptance_proxy(config: dict[str, Any]) -> None:
    """Add our fixed synthetic fixture only after inherited services are validated."""
    config["services"]["edge"] = {
        "build": {"context": str(ROOT / "examples/acceptance-proxy")},
        "ports": [
            {"target": 443, "published": "0", "host_ip": "127.0.0.1", "protocol": "tcp"}
        ],
        "restart": "no",
        "depends_on": {
            "frontend": {"condition": "service_started"},
            "mcp": {"condition": "service_started"},
        },
    }


class Run:
    def __init__(self, artifact: Path, key: str) -> None:
        self.artifact, self.key = artifact, key
        self.env = {
            **os.environ,
            "OPENROUTER_API_KEY": "",
            "SECOND_BRAIN_WIKI_API_KEY": "",
        }
        self.client = build_opener(ProxyHandler({}))
        self.steps: list[str] = []
        self.projects: list[list[str]] = []

    def command(
        self,
        args: list[str],
        *,
        timeout: int = 180,
        expected: int = 0,
        record_output: bool = True,
    ) -> str:
        result = subprocess.run(
            args,
            cwd=ROOT,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = result.stdout + result.stderr
        if record_output:
            with (self.artifact / "compose.log").open("a", encoding="utf-8") as log:
                log.write(output.replace(self.key, "[synthetic-key-redacted]"))
        if result.returncode != expected:
            raise RuntimeError(
                f"command failed (exit {result.returncode}, expected {expected}); see compose.log"
            )
        return result.stdout

    def http(
        self,
        url: str,
        *,
        body: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        expected: int = 200,
    ) -> tuple[bytes, Any]:
        req = Request(
            url,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        try:
            response = self.client.open(req, timeout=10)
        except HTTPError as exc:
            response = exc
        with response:
            content, meta = response.read(), response.headers
            if response.status != expected:
                raise RuntimeError(
                    f"HTTP status {response.status}, expected {expected}"
                )
        return content, meta

    def data(self, url: str, **kwargs: Any) -> Any:
        return json.loads(self.http(url, **kwargs)[0])

    def wait(self, url: str, timeout: int = 90) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                self.http(url)
                return
            except (OSError, URLError, RuntimeError):
                time.sleep(0.5)
        raise RuntimeError("container endpoint readiness timed out")

    def rpc(self, url: str, method: str, params: dict[str, Any] | None = None) -> Any:
        data = self.data(
            url,
            body={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
            headers={
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {self.key}",
            },
        )
        if "error" in data:
            raise RuntimeError("MCP RPC failed")
        return data["result"]

    def initialize(self, url: str) -> Any:
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                return self.rpc(
                    url,
                    "initialize",
                    {
                        "protocolVersion": "2025-03-26",
                        "capabilities": {},
                        "clientInfo": {"name": "compose-acceptance", "version": "1"},
                    },
                )
            except (OSError, URLError, RuntimeError):
                time.sleep(0.5)
        raise RuntimeError("MCP readiness timed out")

    def port(self, compose: list[str], service: str, target: int) -> str:
        address = self.command([*compose, "port", service, str(target)]).strip()
        if not address.startswith("127.0.0.1:") or not address[10:].isdigit():
            raise RuntimeError("expected a dynamic loopback port")
        return ("https://" if target == 443 else "http://") + address

    def exercise_proxy(self, compose: list[str], temp: Path) -> None:
        base = self.port(compose, "edge", 443)
        certificate = temp / "fixture-cert.pem"
        self.command(
            [*compose, "cp", "edge:/etc/nginx/fixture/cert.pem", str(certificate)]
        )
        # Trust only this disposable certificate, with hostname verification enabled.
        self.client = build_opener(
            ProxyHandler({}),
            HTTPSHandler(context=ssl.create_default_context(cafile=certificate)),
        )
        basic = "Basic " + base64.b64encode(b"fixture:fixture-password").decode()
        auth = {"Authorization": basic}
        self.check(
            "https-verified-certificate",
            b"Basic" in self.http(base, expected=401)[1]["WWW-Authenticate"].encode(),
        )
        routes = (
            "/",
            "/wiki/home",
            "/manifest.webmanifest",
            "/service-worker.js",
            "/api/wiki/health",
            "/api/wiki/pages/home",
        )
        for path in routes:
            _, denied = self.http(base + path, expected=401)
            self.check(
                "proxy-denies-anonymous-" + path,
                denied.get("WWW-Authenticate", "").startswith("Basic"),
            )
            self.http(
                base + path,
                headers={"Authorization": "Basic Zml4dHVyZTp3cm9uZw=="},
                expected=401,
            )
            self.check(
                "proxy-authenticated-" + path,
                bool(self.http(base + path, headers=auth)[0]),
            )
        manifest = self.data(base + "/manifest.webmanifest", headers=auth)
        for icon in manifest["icons"]:
            self.http(base + "/" + icon["src"].lstrip("/"), expected=401)
            self.check(
                "proxy-icon-" + icon["src"],
                bool(self.http(base + "/" + icon["src"].lstrip("/"), headers=auth)[0]),
            )
        _, headers = self.http(base + "/service-worker.js", headers=auth)
        self.check(
            "proxy-worker-no-store", "no-store" in headers.get("Cache-Control", "")
        )
        _, headers = self.http(base + "/api/wiki/pages/home", headers=auth)
        self.check("proxy-private-no-store", headers.get("Cache-Control") == "no-store")
        payload = {
            "markdown": "# HTTPS fixture\n\nFictional proxy rehearsal.",
            "base_revision": None,
            "request_id": "https-create",
        }
        browser = {**auth, "Origin": base}
        page_url = base + "/api/wiki/pages/https-fixture"
        receipt = self.data(page_url, body=payload, headers=browser)
        self.check(
            "proxy-same-origin-save-retry",
            self.data(page_url, body=payload, headers=browser) == receipt,
        )
        page = self.data(page_url, headers=auth)
        self.check("proxy-rest-readback", page["revision"] == receipt["revision"])
        self.data(
            page_url,
            body={**payload, "request_id": "https-stale"},
            headers=browser,
            expected=409,
        )
        self.steps.append("proxy-stale-write-conflict")
        denied = self.data(
            page_url,
            body={
                **payload,
                "base_revision": page["revision"],
                "request_id": "https-foreign",
            },
            headers={**auth, "Origin": "https://foreign.invalid"},
            expected=403,
        )
        self.check(
            "proxy-foreign-origin-no-write",
            denied["error"] == "origin_rejected"
            and self.data(page_url, headers=auth) == page,
        )
        bearer = {
            "Authorization": f"Bearer {self.key}",
            "Accept": "application/json, text/event-stream",
            "Origin": base,
        }
        mcp = base + "/mcp"
        for bad in ({}, auth, {"Authorization": "Bearer wrong"}):
            self.check(
                "proxy-mcp-denies-bad-auth",
                self.data(mcp, body={}, headers=bad, expected=401)["error"]
                == "unauthorized",
            )
        initialized = self.data(
            mcp,
            headers=bearer,
            body={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "https-acceptance", "version": "1"},
                },
            },
        )
        self.check(
            "proxy-mcp-https-origin",
            "wiki://guidance" in initialized["result"]["instructions"],
        )
        self.check(
            "proxy-mcp-origin-denied",
            self.data(
                mcp,
                body={},
                headers={**bearer, "Origin": "https://foreign.invalid"},
                expected=403,
            )["error"]
            == "origin_rejected",
        )
        self.check(
            "proxy-mcp-host-denied",
            self.data(
                mcp,
                body={},
                headers={**bearer, "Host": "foreign.invalid"},
                expected=421,
            )["error"]
            == "host_rejected",
        )
        shared = self.rpc(
            mcp,
            "tools/call",
            {"name": "get_page", "arguments": {"id": "https-fixture"}},
        )
        self.check(
            "proxy-mcp-rest-shared",
            shared["structuredContent"]["revision"] == page["revision"],
        )
        edit = {
            **payload,
            "id": "https-fixture",
            "base_revision": page["revision"],
            "request_id": "https-mcp-edit",
            "markdown": payload["markdown"] + "\nUpdated through TLS MCP.",
        }
        updated = self.rpc(mcp, "tools/call", {"name": "save_page", "arguments": edit})
        self.check("proxy-mcp-save", not updated.get("isError", False))
        current = self.data(page_url, headers=auth)
        self.check(
            "proxy-mcp-write-visible",
            current["revision"] == updated["structuredContent"]["revision"]
            and current["markdown"] == edit["markdown"],
        )
        retry = self.rpc(mcp, "tools/call", {"name": "save_page", "arguments": edit})
        self.check(
            "proxy-mcp-retry",
            retry["structuredContent"]["revision"] == current["revision"],
        )

    def check(self, name: str, condition: bool) -> None:
        if not condition:
            raise RuntimeError(f"gate failed: {name}")
        self.steps.append(name)

    def exercise(
        self, compose: list[str]
    ) -> tuple[str, dict[str, Any], dict[str, Any]]:
        base = self.port(compose, "frontend", 80)
        mcp = self.port(compose, "mcp", 3001) + "/mcp"
        self.wait(base + "/api/wiki/health")
        initialized = self.initialize(mcp)
        self.check(
            "nginx-api-health",
            self.data(base + "/api/wiki/health")["profile"] == "managed-wiki",
        )
        for route in ("/", "/wiki/home"):
            self.check("spa-" + route, b"<html" in self.http(base + route)[0])
        manifest = self.data(base + "/manifest.webmanifest")
        self.check(
            "manifest", manifest["display"] == "standalone" and bool(manifest["icons"])
        )
        worker, headers = self.http(base + "/service-worker.js")
        self.check(
            "worker-update",
            bool(worker) and "no-store" in headers.get("Cache-Control", ""),
        )
        _, headers = self.http(base + "/api/wiki/pages")
        self.check("private-no-store", headers.get("Cache-Control") == "no-store")
        self.check(
            "template-pages", len(self.data(base + "/api/wiki/pages")["pages"]) == 12
        )
        payload = {
            "markdown": "# Stack fixture\n\nOnly fictional data. [[home|Home]]",
            "base_revision": None,
            "request_id": "stack-create",
        }
        saved = self.data(base + "/api/wiki/pages/stack-fixture", body=payload)
        self.check(
            "api-save-retry",
            self.data(base + "/api/wiki/pages/stack-fixture", body=payload) == saved,
        )
        self.data(
            base + "/api/wiki/pages/stack-fixture",
            body={**payload, "request_id": "stale"},
            expected=409,
        )
        self.steps.append("api-conflict")
        denied = self.data(mcp, body={}, expected=401)
        self.check("mcp-bearer-denied", denied["error"] == "unauthorized")
        self.check("mcp-initialize", "wiki://guidance" in initialized["instructions"])
        self.check(
            "mcp-tools",
            {t["name"] for t in self.rpc(mcp, "tools/list")["tools"]} == TOOLS,
        )
        self.check(
            "mcp-guidance",
            bool(
                self.rpc(mcp, "resources/read", {"uri": "wiki://guidance"})["contents"][
                    0
                ]["text"]
            ),
        )
        edit = {
            **payload,
            "id": "stack-fixture",
            "base_revision": saved["revision"],
            "request_id": "stack-mcp-edit",
            "markdown": payload["markdown"] + "\nEdited through MCP.",
        }
        updated = self.rpc(mcp, "tools/call", {"name": "save_page", "arguments": edit})
        self.check("mcp-save", not updated.get("isError", False))
        page = self.data(base + "/api/wiki/pages/stack-fixture")
        self.check(
            "mcp-rest-shared",
            page["markdown"] == edit["markdown"]
            and page["revision"] == updated["structuredContent"]["revision"],
        )
        history = self.data(base + "/api/wiki/pages/stack-fixture/history")
        self.check("history", len(history["history"]) == 2)
        graph = self.data(base + "/api/wiki/graph")
        self.check(
            "graph-link",
            any(
                e["source"] == "stack-fixture" and e["target"] == "home"
                for e in graph["edges"]
            ),
        )
        self.command([*compose, "restart", "backend", "mcp"])
        self.wait(base + "/api/wiki/health")
        # Docker may allocate a new ephemeral host port when a container restarts.
        mcp = self.port(compose, "mcp", 3001) + "/mcp"
        self.initialize(mcp)
        self.check(
            "restart-page", self.data(base + "/api/wiki/pages/stack-fixture") == page
        )
        retry = self.rpc(mcp, "tools/call", {"name": "save_page", "arguments": edit})
        self.check(
            "restart-retry-receipt",
            retry["structuredContent"]["revision"] == page["revision"],
        )
        return base, edit, history


def main() -> int:
    artifact = (
        ROOT
        / ".demo"
        / "stack-acceptance"
        / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    )
    artifact.mkdir(parents=True)
    run = Run(artifact, secrets.token_urlsafe(32))
    start = datetime.now(UTC)
    result: dict[str, Any] = {
        "schema": 1,
        "status": "failed",
        "external_model_calls": False,
        "physical_device": False,
        "production_https": False,
    }
    docker = ["docker", "--context", "default"]
    project = "sb-acceptance-" + uuid4().hex[:12]

    def interrupt(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        endpoint = json.loads(
            run.command(
                [
                    *docker,
                    "context",
                    "inspect",
                    "default",
                    "--format",
                    "{{json .Endpoints.docker.Host}}",
                ]
            )
        )
        if not endpoint.startswith(("unix://", "npipe://")):
            raise RuntimeError("only a local default Docker runtime is accepted")
        run.command([*docker, "info", "--format", "{{.ServerVersion}}"])
        with tempfile.TemporaryDirectory(prefix="sb-stack-") as temporary:
            temp = Path(temporary)
            env_file = temp / "empty.env"
            env_file.touch()
            original = [
                *docker,
                "compose",
                "-p",
                project,
                "--env-file",
                str(env_file),
                "-f",
                str(ROOT / "docker-compose.wiki.yml"),
            ]
            raw = json.loads(
                run.command(
                    [*original, "config", "--format", "json"], record_output=False
                )
            )
            original_path = temp / "original.json"
            isolated = isolated_config(raw, project, run.key)
            add_acceptance_proxy(isolated)
            original_path.write_text(json.dumps(isolated))
            compose = [*docker, "compose", "-p", project, "-f", str(original_path)]
            run.projects.append(compose)
            try:
                run.command([*compose, "build"], timeout=600)
                run.steps.append("compose-build")
                seed = [
                    "run",
                    "--rm",
                    "--no-deps",
                    "-v",
                    f"{ROOT / 'examples/demo-vault'}:/template:ro",
                    "backend",
                    "python",
                    "-m",
                    "second_brain.wiki.setup",
                    "--vault",
                    "/managed-vault",
                    "--mode",
                    "template",
                    "--template",
                    "/template",
                ]
                seeded = json.loads(run.command([*compose, *seed]))
                run.check("explicit-template", seeded["pages"] == 12)
                repeated = json.loads(run.command([*compose, *seed]))
                run.check("template-repeat", repeated["status"] == "unchanged")
                run.command([*compose, "up", "-d", "--wait"], timeout=150)
                base, edit, history = run.exercise(compose)
                run.exercise_proxy(compose, temp)
                result["synthetic_https_auth"] = True
                page = run.data(base + "/api/wiki/pages/stack-fixture")
                run.command([*compose, *seed], expected=1)
                run.check(
                    "reseed-preserves-content",
                    run.data(base + "/api/wiki/pages/stack-fixture") == page,
                )
                run.command(
                    [
                        *compose,
                        "exec",
                        "-T",
                        "backend",
                        "python",
                        "-m",
                        "second_brain.wiki.backup",
                        "create",
                        "--vault",
                        "/managed-vault",
                        "--archive",
                        "/tmp/stack-backup.tar.gz",
                    ]
                )
                run.command(
                    [
                        *compose,
                        "cp",
                        "backend:/tmp/stack-backup.tar.gz",
                        str(temp / "backup.tar.gz"),
                    ]
                )
                restore_project = project + "-restore"
                restore_raw = json.loads(original_path.read_text())
                restore_raw["services"].pop("edge")
                restore_path = temp / "restore.json"
                restore_path.write_text(
                    json.dumps(
                        isolated_config(
                            restore_raw, restore_project, run.key, restored=True
                        )
                    )
                )
                restored = [
                    *docker,
                    "compose",
                    "-p",
                    restore_project,
                    "-f",
                    str(restore_path),
                ]
                run.projects.append(restored)
                # Reuse the built images; the independent project owns a new named volume.
                for name in ("backend", "mcp", "frontend"):
                    restore_raw["services"][name]["image"] = f"{project}-{name}"
                    restore_raw["services"][name].pop("build", None)
                restore_path.write_text(json.dumps(restore_raw))
                backup = json.loads(
                    run.command(
                        [
                            *restored,
                            "run",
                            "--rm",
                            "--no-deps",
                            "-v",
                            f"{temp}:/acceptance:ro",
                            "backend",
                            "python",
                            "-m",
                            "second_brain.wiki.backup",
                            "restore",
                            "--archive",
                            "/acceptance/backup.tar.gz",
                            "--vault",
                            "/managed-vault/restored",
                        ]
                    )
                )
                run.check("independent-volume-restore", backup["page_count"] == 14)
                run.command([*restored, "up", "-d", "--wait"], timeout=150)
                restored_base = run.port(restored, "frontend", 80)
                run.wait(restored_base + "/api/wiki/health")
                run.check(
                    "restored-page",
                    run.data(restored_base + "/api/wiki/pages/stack-fixture") == page,
                )
                run.check(
                    "restored-history",
                    run.data(restored_base + "/api/wiki/pages/stack-fixture/history")
                    == history,
                )
                mcp = run.port(restored, "mcp", 3001) + "/mcp"
                run.initialize(mcp)
                retry = run.rpc(
                    mcp, "tools/call", {"name": "save_page", "arguments": edit}
                )
                run.check(
                    "restored-retry-receipt",
                    retry["structuredContent"]["revision"] == page["revision"],
                )
                result["status"] = "passed"
            finally:
                clean = True
                for ctx in reversed(run.projects):
                    try:
                        run.command([*ctx, "logs", "--no-color"], timeout=30)
                    except (OSError, RuntimeError, subprocess.TimeoutExpired):
                        pass  # Log collection must never prevent resource cleanup.
                    try:
                        run.command(
                            [*ctx, "down", "--volumes", "--remove-orphans"], timeout=90
                        )
                    except (OSError, RuntimeError, subprocess.TimeoutExpired):
                        clean = False
                result["cleanup_ok"] = clean
                if not clean:
                    raise RuntimeError("isolated project cleanup failed")
    except (
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.TimeoutExpired,
        KeyboardInterrupt,
    ) as exc:
        result["status"] = "failed"
        result["failure"] = str(exc).replace(run.key, "[synthetic-key-redacted]")
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    result.update(
        git_head=head.stdout.strip() if head.returncode == 0 else None,
        started_at=start.isoformat(),
        finished_at=datetime.now(UTC).isoformat(),
        gates=run.steps,
    )
    (artifact / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Managed stack {result['status']}. Evidence: {artifact / 'result.json'}")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
