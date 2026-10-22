"""Exercise the real managed Compose images in disposable local projects."""

from __future__ import annotations

import base64
import contextlib
import ipaddress
import itertools
import json
import os
import secrets
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
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
DOCKER = ["docker", "--context", "default"]
CONTAINER_SNAPSHOT = (
    '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
    '"status":{{json .State.Status}},"running":{{json .State.Running}},'
    '"exit_code":{{json .State.ExitCode}},"restart_count":{{json .RestartCount}},'
    '"started_at":{{json .State.StartedAt}},'
    '"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}},'
    '"networks":{{json .NetworkSettings.Networks}}}'
)
NETWORK_SNAPSHOT = (
    '{"id":{{json .Id}},"project":{{json (index .Labels "com.docker.compose.project")}},'
    '"probe_owner":{{json (index .Labels "secondbrain.acceptance.probe-owner")}},'
    '"driver":{{json .Driver}},"ipam":{{json .IPAM.Config}},"containers":{{json .Containers}}}'
)


def replacement_ip(network: dict[str, Any], old_ip: str) -> str:
    """Choose a free address from Docker's actual allocation pool, never a fixed subnet."""
    occupied = {
        ipaddress.ip_interface(c["IPv4Address"]).ip
        for c in network["containers"].values()
        if c.get("IPv4Address")
    }
    occupied.add(ipaddress.ip_address(old_ip))
    for pool in network["ipam"]:
        subnet = ipaddress.ip_network(pool.get("IPRange") or pool["Subnet"])
        if subnet.version != 4 or ipaddress.ip_address(old_ip) not in ipaddress.ip_network(
            pool["Subnet"]
        ):
            continue
        for key in ("Gateway",):
            if pool.get(key):
                occupied.add(ipaddress.ip_address(pool[key]))
        occupied.update(
            ipaddress.ip_address(v) for v in pool.get("AuxiliaryAddresses", {}).values()
        )
        for address in itertools.islice(subnet.hosts(), 65536):
            if address not in occupied:
                return str(address)
    raise RuntimeError("no safe free IPv4 address in owned network")


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
            if resource == "networks":
                value.pop("ipam", None)  # Never reuse an inherited allocation pool.
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
                        "SECOND_BRAIN_WIKI_MCP_ALLOWED_HOSTS": (
                            "localhost,localhost:*,127.0.0.1,127.0.0.1:*"
                        ),
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
        "ports": [{"target": 443, "published": "0", "host_ip": "127.0.0.1", "protocol": "tcp"}],
        "restart": "no",
        "depends_on": {
            "frontend": {"condition": "service_started"},
            "mcp": {"condition": "service_started"},
        },
    }


def validate_recovery_config(
    config: dict[str, Any], volume: str, images: dict[str, str]
) -> None:
    """Check the actual Compose merge before starting an inspection writer."""
    if set(config["services"]) != {"backend", "mcp", "frontend"}:
        raise RuntimeError("unexpected recovery services")
    resource = config["volumes"]["managed_wiki"]
    if resource.get("external") is not True or resource.get("name") != volume:
        raise RuntimeError("recovery volume selection changed")
    if any(v.get("external") for v in config.get("networks", {}).values()):
        raise RuntimeError("recovery must not attach to a proxy network")
    for name, service in config["services"].items():
        if service.get("image") != images[name] or service.get("pull_policy") != "never":
            raise RuntimeError("recovery must retain the selected local image")
        if service.get("container_name"):
            raise RuntimeError("fixed recovery container name refused")
        if name == "frontend" and service.get("volumes"):
            raise RuntimeError("unexpected recovery frontend mount")
        for port in service.get("ports", []):
            if port.get("host_ip") != "127.0.0.1" or str(port.get("published")) != "0":
                raise RuntimeError("acceptance recovery needs dynamic loopback ports")
        if name in {"backend", "mcp"}:
            env = service["environment"]
            if (
                env.get("SECOND_BRAIN_WIKI_VAULT") != "/managed-vault/restored"
                or env.get("OPENROUTER_API_KEY") != ""
                or env.get("SECOND_BRAIN_WIKI_DELIVERY") != "0"
            ):
                raise RuntimeError("recovery must inspect the restored path without providers")
            mounts = service.get("volumes", [])
            if len(mounts) != 1 or any(
                mounts[0].get(k) != v
                for k, v in {
                    "type": "volume", "source": "managed_wiki", "target": "/managed-vault"
                }.items()
            ):
                raise RuntimeError("unexpected recovery mount")


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
        self.probe_networks: list[str] = []
        self.probe_owners: dict[str, tuple[str, str]] = {}
        self.recovery_volumes: dict[str, str] = {}

    def create_recovery_volume(self, name: str) -> None:
        existing = self.command(
            [*DOCKER, "volume", "ls", "--filter", f"name=^{name}$", "--format", "{{.Name}}"],
            record_output=False,
        ).strip()
        if existing:
            raise RuntimeError("recovery volume already exists")
        owner = uuid4().hex
        self.recovery_volumes[name] = owner  # Track a timed-out create too.
        self.command(
            [*DOCKER, "volume", "create", "--label", f"secondbrain.acceptance.owner={owner}", name]
        )
        self.recovery_volume_owner(name, owner)

    def recovery_volume_owner(self, name: str, owner: str) -> None:
        actual = json.loads(
            self.command(
                [
                    *DOCKER, "volume", "inspect", "--format",
                    '{{json (index .Labels "secondbrain.acceptance.owner")}}', name,
                ],
                record_output=False,
            )
        )
        if actual != owner:
            raise RuntimeError("recovery volume ownership mismatch")

    def cleanup_recovery_volume(self, name: str) -> None:
        exists = self.command(
            [*DOCKER, "volume", "ls", "--filter", f"name=^{name}$", "--format", "{{.Name}}"],
            record_output=False,
        ).strip()
        if exists:
            self.recovery_volume_owner(name, self.recovery_volumes[name])
            # Docker refuses removal while any container still mounts the volume.
            self.command([*DOCKER, "volume", "rm", name])
        del self.recovery_volumes[name]

    def cleanup_probe_network(self, name: str) -> None:
        """Remove only an empty network carrying this run's ownership token."""
        identifier = self.command(
            [
                *DOCKER,
                "network",
                "ls",
                "--filter",
                f"name=^{name}$",
                "--format",
                "{{.ID}}",
            ],
            record_output=False,
            timeout=10,
        ).strip()
        if identifier:
            network = json.loads(
                self.command(
                    [
                        *DOCKER,
                        "network",
                        "inspect",
                        "--format",
                        NETWORK_SNAPSHOT,
                        identifier,
                    ],
                    record_output=False,
                    timeout=10,
                )
            )
            project, owner = self.probe_owners[name]
            if (
                network["project"] != project
                or network.get("probe_owner") != owner
                or network["containers"]
            ):
                raise RuntimeError("unexpected subnet probe ownership or endpoints")
            self.command([*DOCKER, "network", "rm", identifier], timeout=10)
        self.probe_networks.remove(name)
        del self.probe_owners[name]

    def configure_churn_network(self, config: dict[str, Any], project: str) -> None:
        """Let Docker select a free pool, then declare it for explicit IP assignment."""
        if not project.startswith("sb-acceptance-"):
            raise RuntimeError("subnet probe requires an owned acceptance project")
        name = project + "-subnet-probe"
        owner = uuid4().hex
        # Register before invoking Docker: a timeout can follow daemon-side creation.
        self.probe_networks.append(name)
        self.probe_owners[name] = (project, owner)
        try:
            self.command(
                [
                    *DOCKER,
                    "network",
                    "create",
                    "--label",
                    f"com.docker.compose.project={project}",
                    "--label",
                    f"secondbrain.acceptance.probe-owner={owner}",
                    name,
                ],
                timeout=10,
            )
            network = json.loads(
                self.command(
                    [
                        *DOCKER,
                        "network",
                        "inspect",
                        "--format",
                        NETWORK_SNAPSHOT,
                        name,
                    ],
                    record_output=False,
                    timeout=10,
                )
            )
            if (
                network["project"] != project
                or network.get("probe_owner") != owner
                or network["containers"]
            ):
                raise RuntimeError("unexpected subnet probe ownership or endpoints")
            pools = [p for p in network["ipam"] if ipaddress.ip_network(p["Subnet"]).version == 4]
            if len(pools) != 1:
                raise RuntimeError("expected one Docker-selected IPv4 pool")
            config["networks"]["default"]["ipam"] = {
                "config": [
                    {
                        "subnet": pools[0]["Subnet"],
                        "gateway": pools[0]["Gateway"],
                    }
                ]
            }
        finally:
            # Keep a failed removal registered for the outer cleanup, and preserve
            # an existing validation failure instead of replacing it.
            failed = sys.exc_info()[0] is not None
            try:
                self.cleanup_probe_network(name)
            except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired):
                if not failed:
                    raise

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
                raise RuntimeError(f"HTTP status {response.status}, expected {expected}")
        return content, meta

    def data(self, url: str, **kwargs: Any) -> Any:
        return json.loads(self.http(url, **kwargs)[0])

    def wait(self, url: str, timeout: int = 90) -> None:
        deadline = time.monotonic() + timeout
        last_failure = "no attempt"
        while time.monotonic() < deadline:
            try:
                self.http(url)
                return
            except (OSError, URLError, RuntimeError) as exc:
                last_failure = type(exc).__name__
                if isinstance(exc, RuntimeError) and str(exc).startswith("HTTP status "):
                    last_failure = str(exc)
                time.sleep(0.5)
        raise RuntimeError(f"container endpoint readiness timed out; last failure: {last_failure}")

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

    def container(self, compose: list[str], service: str) -> dict[str, Any]:
        container_id = self.command(
            [*compose, "ps", "-a", "-q", service], record_output=False, timeout=10
        ).strip()
        if not container_id or len(container_id.splitlines()) != 1:
            raise RuntimeError("expected one acceptance container")
        snapshot: dict[str, Any] = json.loads(
            self.command(
                [*DOCKER, "inspect", "--format", CONTAINER_SNAPSHOT, container_id],
                record_output=False,
                timeout=10,
            )
        )
        return snapshot

    def diagnostics(self, compose: list[str], phase: str = "failure") -> None:
        """Best effort allowlisted state only; never inspect environment or health output."""
        snapshot: dict[str, Any] = {
            "phase": phase,
            "gates_completed": list(self.steps),
            "containers": {},
        }
        for service in ("backend", "mcp", "frontend", "edge"):
            try:
                snapshot["containers"][service] = self.container(compose, service)
            except Exception as exc:
                snapshot["containers"][service] = {"diagnostic_error": type(exc).__name__}
        try:
            with (self.artifact / "restart-diagnostics.jsonl").open(
                "a", encoding="utf-8"
            ) as output:
                output.write(
                    json.dumps(snapshot).replace(self.key, "[synthetic-key-redacted]") + "\n"
                )
        except OSError:
            pass

    def backend_health(self, compose: list[str]) -> None:
        self.command(
            [
                *compose,
                "exec",
                "-T",
                "backend",
                "python",
                "-c",
                "import urllib.request; "
                "urllib.request.urlopen('http://127.0.0.1:8000/api/wiki/health', "
                "timeout=10).read()",
            ],
            timeout=20,
        )

    def exercise_dns_churn(
        self,
        compose: list[str],
        base: str,
        page: dict[str, Any],
        edit: dict[str, Any],
        history: dict[str, Any],
    ) -> None:
        backend, frontend = (
            self.container(compose, "backend"),
            self.container(compose, "frontend"),
        )
        project = compose[compose.index("-p") + 1]
        if not project.startswith("sb-acceptance-") or any(
            c["project"] != project or c["service"] != service
            for c, service in ((backend, "backend"), (frontend, "frontend"))
        ):
            raise RuntimeError("DNS churn requires owned acceptance containers")
        shared = set(backend["networks"]) & set(frontend["networks"])
        if len(shared) != 1 or len(backend["networks"]) != 1:
            raise RuntimeError("DNS churn requires one shared isolated network")
        name = shared.pop()
        network = json.loads(
            self.command(
                [*DOCKER, "network", "inspect", "--format", NETWORK_SNAPSHOT, name],
                record_output=False,
            )
        )
        if network["project"] != project or network["driver"] != "bridge":
            raise RuntimeError("DNS churn requires owned bridge network")
        # Every endpoint must belong to this disposable project before modifying it.
        for container_id in network["containers"]:
            member = json.loads(
                self.command(
                    [*DOCKER, "inspect", "--format", CONTAINER_SNAPSHOT, container_id],
                    record_output=False,
                )
            )
            if member["project"] != project:
                raise RuntimeError("foreign endpoint in acceptance network")
        old_ip = backend["networks"][name]["IPAddress"]
        address = replacement_ip(network, old_ip)
        self.backend_health(compose)
        self.steps.append("dns-churn-backend-healthy-before")
        self.diagnostics(compose, "dns-churn-before")
        self.command([*DOCKER, "network", "disconnect", name, backend["id"]])
        self.command(
            [
                *DOCKER,
                "network",
                "connect",
                "--ip",
                address,
                "--alias",
                "backend",
                name,
                backend["id"],
            ]
        )
        current = self.container(compose, "backend")
        self.check(
            "dns-churn-backend-ip-changed",
            current["id"] == backend["id"]
            and current["networks"][name]["IPAddress"] == address
            and address != old_ip,
        )
        self.backend_health(compose)
        self.steps.append("dns-churn-backend-healthy-after")
        self.diagnostics(compose, "dns-churn-after")
        self.wait(base + "/api/wiki/health")
        self.check(
            "dns-churn-api-health",
            self.data(base + "/api/wiki/health")["profile"] == "managed-wiki",
        )
        page_url = base + "/api/wiki/pages/stack-fixture"
        receipt = self.data(
            page_url, body={key: value for key, value in edit.items() if key != "id"}
        )
        self.check("dns-churn-save-retry", receipt["revision"] == page["revision"])
        self.data(
            page_url,
            body={
                key: value
                for key, value in {**edit, "request_id": "dns-churn-stale"}.items()
                if key != "id"
            },
            expected=409,
        )
        self.steps.append("dns-churn-stale-write-conflict")
        self.check("dns-churn-read", self.data(page_url) == page)
        self.check(
            "dns-churn-encoded-path",
            self.data(base + "/api/wiki/pages/%73tack-fixture") == page,
        )
        self.check("dns-churn-history", self.data(page_url + "/history") == history)
        search = self.data(base + "/api/wiki/search?q=Stack%20fixture&mode=lexical")
        self.check(
            "dns-churn-query",
            any(item["id"] == "stack-fixture" for item in search["results"]),
        )
        self.data(base + "/api/wiki/search?q=Stack%20fixture&mode=invalid", expected=400)
        self.steps.append("dns-churn-invalid-query-mode")
        after = self.container(compose, "frontend")
        self.check(
            "dns-churn-frontend-not-restarted",
            all(after[key] == frontend[key] for key in ("id", "started_at", "restart_count")),
        )

    def exercise_chat_proxy(
        self, compose: list[str], temp: Path, config: dict[str, Any], config_path: Path
    ) -> None:
        """Swap only the owned backend's provider; exercise both real nginx hops."""
        original_command = config["services"]["backend"].get("command")
        fixture = (ROOT / "scripts/fixtures/proxy-chat.py").read_text()
        config["services"]["backend"]["command"] = ["python", "-c", fixture]
        config_path.write_text(json.dumps(config))
        base = self.port(compose, "edge", 443)
        certificate = temp / "fixture-cert.pem"
        tls = ssl.create_default_context(cafile=certificate)
        self.client = build_opener(ProxyHandler({}), HTTPSHandler(context=tls))
        basic = "Basic " + base64.b64encode(b"fixture:fixture-password").decode()
        auth = {"Authorization": basic}
        control = base + "/api/wiki/__acceptance/chat-control"
        connection: ssl.SSLSocket | None = None

        def wait_state(field: str, key: str) -> dict[str, Any]:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                state = self.data(control, headers=auth)
                if key in state[field]:
                    return state
                time.sleep(0.1)
            raise RuntimeError(f"synthetic provider did not report {field}: {key}")

        def chat(key: str) -> tuple[bytes, Any]:
            return self.http(
                base + "/api/wiki/chat",
                body={"messages": [{"role": "user", "content": key}]},
                headers={**auth, "Origin": base},
            )

        try:
            self.command([*compose, "up", "-d", "--wait", "--no-deps", "--force-recreate", "backend"])
            self.backend_health(compose)
            # The control route exists only in this fixture; wait for Docker DNS
            # caches to reach its replacement, not a stale healthy backend.
            deadline = time.monotonic() + 15
            while True:
                try:
                    self.data(control, headers=auth)
                    break
                except (OSError, URLError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("synthetic chat backend readiness timed out") from None
                    time.sleep(0.5)
            self.http(control, expected=401)
            self.steps.append("proxy-chat-control-authenticated")
            address = urlsplit(base)
            raw = socket.create_connection((address.hostname, address.port), timeout=5)
            try:
                connection = tls.wrap_socket(raw, server_hostname=address.hostname)
            except BaseException:
                raw.close()
                raise
            payload = json.dumps(
                {"messages": [{"role": "user", "content": "proxy-cancel"}]}
            ).encode()
            connection.sendall(
                (
                    f"POST /api/wiki/chat HTTP/1.1\r\nHost: {address.netloc}\r\n"
                    f"Authorization: {basic}\r\nOrigin: {base}\r\n"
                    f"Content-Type: application/json\r\nContent-Length: {len(payload)}\r\n\r\n"
                ).encode() + payload
            )
            wait_state("started", "proxy-cancel")
            with ThreadPoolExecutor(max_workers=1) as pool:
                survivor = pool.submit(chat, "proxy-survivor")
                wait_state("started", "proxy-survivor")
                connection.shutdown(socket.SHUT_RDWR)
                connection.close()
                connection = None
                state = wait_state("cancelled", "proxy-cancel")
                wait_state("finished", "proxy-cancel")
                self.check(
                    "proxy-chat-disconnect-isolated",
                    "proxy-survivor" not in state["cancelled"]
                    and "proxy-survivor" not in state["finished"]
                    and not survivor.done(),
                )
                self.data(control, body={"release": "proxy-survivor"}, headers=auth)
                content, headers = survivor.result(timeout=5)
                self.check(
                    "proxy-chat-survivor-200-no-store",
                    "proxy-survivor" in json.loads(content)["answer"]
                    and headers.get("Cache-Control") == "no-store",
                )
                retry = pool.submit(chat, "proxy-retry")
                wait_state("started", "proxy-retry")
                self.data(control, body={"release": "proxy-retry"}, headers=auth)
                content, headers = retry.result(timeout=5)
                self.check(
                    "proxy-chat-retry-200-no-store",
                    "proxy-retry" in json.loads(content)["answer"]
                    and headers.get("Cache-Control") == "no-store",
                )
                state = self.data(control, headers=auth)
                self.check(
                    "proxy-chat-all-invocations-finished",
                    set(state["finished"]) == {"proxy-cancel", "proxy-survivor", "proxy-retry"}
                    and state["cancelled"] == ["proxy-cancel"],
                )
        finally:
            failed = sys.exc_info()[0] is not None
            if connection is not None:
                connection.close()
            if original_command is None:
                config["services"]["backend"].pop("command", None)
            else:
                config["services"]["backend"]["command"] = original_command
            config_path.write_text(json.dumps(config))
            try:
                self.command([*compose, "up", "-d", "--wait", "--no-deps", "--force-recreate", "backend"])
                self.backend_health(compose)
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                if not failed:
                    raise
            finally:
                self.client = build_opener(ProxyHandler({}))
        frontend = self.port(compose, "frontend", 80)
        self.wait(frontend + "/api/wiki/health")
        deadline = time.monotonic() + 15
        while True:
            try:
                self.http(frontend + "/api/wiki/__acceptance/chat-control", expected=404)
                break
            except (OSError, URLError, RuntimeError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("production backend retained the fixture control") from None
                time.sleep(0.5)
        self.steps.append("proxy-chat-production-command-restored")

    def exercise_proxy(self, compose: list[str], temp: Path) -> None:
        base = self.port(compose, "edge", 443)
        certificate = temp / "fixture-cert.pem"
        self.command([*compose, "cp", "edge:/etc/nginx/fixture/cert.pem", str(certificate)])
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
        self.check("proxy-worker-no-store", "no-store" in headers.get("Cache-Control", ""))
        _, headers = self.http(base + "/api/wiki/pages/home", headers=auth)
        self.check("proxy-private-no-store", headers.get("Cache-Control") == "no-store")
        payload: dict[str, Any] = {
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
            denied["error"] == "origin_rejected" and self.data(page_url, headers=auth) == page,
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
                self.data(mcp, body={}, headers=bad, expected=401)["error"] == "unauthorized",
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

    def exercise(self, compose: list[str]) -> tuple[str, dict[str, Any], dict[str, Any]]:
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
        self.check("manifest", manifest["display"] == "standalone" and bool(manifest["icons"]))
        worker, headers = self.http(base + "/service-worker.js")
        self.check(
            "worker-update",
            bool(worker) and "no-store" in headers.get("Cache-Control", ""),
        )
        _, headers = self.http(base + "/api/wiki/pages")
        self.check("private-no-store", headers.get("Cache-Control") == "no-store")
        self.check("template-pages", len(self.data(base + "/api/wiki/pages")["pages"]) == 12)
        payload: dict[str, Any] = {
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
                self.rpc(mcp, "resources/read", {"uri": "wiki://guidance"})["contents"][0]["text"]
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
            any(e["source"] == "stack-fixture" and e["target"] == "home" for e in graph["edges"]),
        )
        self.command([*compose, "restart", "backend", "mcp"])
        self.wait(base + "/api/wiki/health")
        # Docker may allocate a new ephemeral host port when a container restarts.
        mcp = self.port(compose, "mcp", 3001) + "/mcp"
        self.initialize(mcp)
        self.check("restart-page", self.data(base + "/api/wiki/pages/stack-fixture") == page)
        retry = self.rpc(mcp, "tools/call", {"name": "save_page", "arguments": edit})
        self.check(
            "restart-retry-receipt",
            retry["structuredContent"]["revision"] == page["revision"],
        )
        self.exercise_dns_churn(compose, base, page, edit, history)
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
                run.command([*original, "config", "--format", "json"], record_output=False)
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
                run.configure_churn_network(isolated, project)
                original_path.write_text(json.dumps(isolated))
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
                if os.environ.get("SECOND_BRAIN_STACK_BROWSER") == "1":
                    browser = json.loads(
                        run.command(
                            [
                                "node",
                                str(ROOT / "frontend/e2e/stack-proxy.mjs"),
                                run.port(compose, "edge", 443),
                                str(temp / "fixture-cert.pem"),
                                str(artifact),
                            ],
                            timeout=90,
                        )
                    )
                    run.check("authenticated-built-browser", browser["status"] == "passed")
                    result["browser_proxy_gates"] = browser["gates"]
                run.exercise_chat_proxy(compose, temp, isolated, original_path)
                result["synthetic_proxy_chat_disconnect"] = True
                page = run.data(base + "/api/wiki/pages/stack-fixture")
                run.command([*compose, *seed], expected=1)
                run.check(
                    "reseed-preserves-content",
                    run.data(base + "/api/wiki/pages/stack-fixture") == page,
                )
                images = {
                    name: json.loads(
                        run.command(
                            [*docker, "inspect", "--format", "{{json .Image}}",
                             run.container(compose, name)["id"]],
                            record_output=False,
                        )
                    )
                    for name in ("backend", "mcp", "frontend")
                }
                run.check(
                    "retained-local-image-ids",
                    all(v.startswith("sha256:") for v in images.values()),
                )
                run.command([*compose, "stop", "frontend", "backend", "mcp"])
                backup = json.loads(
                    run.command(
                        [
                            *compose, "run", "--rm", "--no-deps", "-T", "--pull", "never",
                            "-v", f"{temp}:/backups", "backend", "sh", "-c",
                            'exec python -m second_brain.wiki.backup create '
                            '--vault "${SECOND_BRAIN_WIKI_VAULT:?Set the active managed vault}" '
                            '--archive "$1"', "sh", "/backups/backup.tar.gz",
                        ]
                    )
                )
                run.check("stopped-one-off-backup", backup["page_count"] == 14)
                restore_project = project + "-restore"
                recovery_volume = restore_project + "_managed_wiki"
                run.create_recovery_volume(recovery_volume)
                restored_backup = json.loads(
                    run.command(
                        [
                            *docker, "run", "--rm", "--network", "none", "--pull", "never",
                            "--entrypoint", "python", "-v", f"{recovery_volume}:/recovery",
                            "-v", f"{temp}:/backups:ro", images["backend"],
                            "-m", "second_brain.wiki.backup", "restore",
                            "--archive", "/backups/backup.tar.gz", "--vault", "/recovery/restored",
                        ]
                    )
                )
                run.check("independent-volume-restore", restored_backup["page_count"] == 14)
                run.env.update(
                    WIKI_BACKEND_IMAGE=images["backend"],
                    WIKI_MCP_IMAGE=images["mcp"],
                    WIKI_FRONTEND_IMAGE=images["frontend"],
                    WIKI_RECOVERY_VOLUME=recovery_volume,
                    WIKI_FRONTEND_PORT="0",
                    WIKI_MCP_PORT="0",
                    SECOND_BRAIN_WIKI_API_KEY=run.key,
                )
                restored = [
                    *docker, "compose", "-p", restore_project, "--env-file", str(env_file),
                    "-f", str(ROOT / "docker-compose.wiki.yml"),
                    "-f", str(ROOT / "docker-compose.wiki.recovery.yml"),
                ]
                actual = json.loads(
                    run.command([*restored, "config", "--format", "json"], record_output=False)
                )
                validate_recovery_config(actual, recovery_volume, images)
                run.steps.append("operator-recovery-overlay-resolved")
                run.projects.append(restored)
                run.command(
                    [*restored, "up", "-d", "--no-build", "--pull", "never", "--wait"],
                    timeout=150,
                )
                for name in images:
                    running = run.container(restored, name)
                    selected = json.loads(
                        run.command(
                            [*docker, "inspect", "--format", "{{json .Image}}", running["id"]],
                            record_output=False,
                        )
                    )
                    run.check(f"recovery-retained-image-{name}", selected == images[name])
                for name in ("backend", "mcp"):
                    mounts = json.loads(
                        run.command(
                            [*docker, "inspect", "--format", "{{json .Mounts}}",
                             run.container(restored, name)["id"]],
                            record_output=False,
                        )
                    )
                    run.check(
                        f"recovery-external-mount-{name}",
                        any(
                            m.get("Name") == recovery_volume
                            and m.get("Destination") == "/managed-vault"
                            for m in mounts
                        ),
                    )
                restored_base = run.port(restored, "frontend", 80)
                run.wait(restored_base + "/api/wiki/health")
                run.check(
                    "restored-page",
                    run.data(restored_base + "/api/wiki/pages/stack-fixture") == page,
                )
                run.check(
                    "restored-history",
                    run.data(restored_base + "/api/wiki/pages/stack-fixture/history") == history,
                )
                mcp = run.port(restored, "mcp", 3001) + "/mcp"
                run.initialize(mcp)
                retry = run.rpc(mcp, "tools/call", {"name": "save_page", "arguments": edit})
                run.check(
                    "restored-retry-receipt",
                    retry["structuredContent"]["revision"] == page["revision"],
                )
                run.command(
                    [*compose, "up", "-d", "--no-build", "--pull", "never", "--wait"],
                    timeout=150,
                )
                base = run.port(compose, "frontend", 80)
                run.wait(base + "/api/wiki/health")
                run.check(
                    "original-preserved-after-recovery",
                    run.data(base + "/api/wiki/pages/stack-fixture") == page
                    and run.data(base + "/api/wiki/pages/stack-fixture/history") == history,
                )
                result["status"] = "passed"
            except BaseException:
                for ctx in run.projects:
                    run.diagnostics(ctx)
                raise
            finally:
                failed = sys.exc_info()[0] is not None
                clean = True
                for name in list(run.probe_networks):
                    try:
                        run.cleanup_probe_network(name)
                    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired):
                        clean = False
                for ctx in reversed(run.projects):
                    # Log collection must never prevent resource cleanup.
                    with contextlib.suppress(OSError, RuntimeError, subprocess.TimeoutExpired):
                        run.command([*ctx, "logs", "--no-color"], timeout=30)
                    try:
                        run.command([*ctx, "down", "--volumes", "--remove-orphans"], timeout=90)
                    except (OSError, RuntimeError, subprocess.TimeoutExpired):
                        clean = False
                for name in list(run.recovery_volumes):
                    try:
                        run.cleanup_recovery_volume(name)
                    except (OSError, ValueError, KeyError, RuntimeError, subprocess.TimeoutExpired):
                        clean = False
                result["cleanup_ok"] = clean
                if not clean and not failed:
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
