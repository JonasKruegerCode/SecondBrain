"""Check a pinned old/new/old image pair on one disposable managed volume.

The optional kept-browser gate uses a secure loopback origin across real image
changes. Neither gate accepts production HTTPS, devices or universal downgrade.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import re
import runpy
import secrets
import select
import signal
import subprocess
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
BASELINE = "dceee9fd63ccd36b5c6d5bd0ebd6cb11b5e25477"
SERVICES = ("backend", "mcp", "frontend")
stack = runpy.run_path(str(ROOT / "scripts/run-wiki-stack-acceptance.py"))
Run = stack["Run"]
DOCKER = stack["DOCKER"]


class BrowserProbe:
    """One owned browser process and stable gateway, never a reconstructed profile."""

    def __init__(self, root: Path, artifact: Path, env: dict[str, str]) -> None:
        self.log = (artifact / "pwa-browser.log").open("w", encoding="utf-8")
        try:
            self.process = subprocess.Popen(
                ["node", str(root / "frontend/e2e/image-update.mjs")],
                cwd=root / "frontend",
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=self.log,
                start_new_session=True,
            )
        except BaseException:
            self.log.close()
            raise
        try:
            self.command("ready", timeout=15)
        except BaseException:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait(timeout=15)
            self.log.close()
            raise

    def command(self, command: str, *, timeout: float = 180, **arguments: Any) -> dict[str, Any]:
        if self.process.poll() is not None:
            raise RuntimeError("owned PWA browser exited before its command")
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write((json.dumps({"command": command, **arguments}) + "\n").encode())
        self.process.stdin.flush()
        deadline = time.monotonic() + timeout
        response = bytearray()
        while b"\n" not in response:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                raise RuntimeError("owned PWA browser command timed out")
            chunk = os.read(self.process.stdout.fileno(), min(4096, 65537 - len(response)))
            response.extend(chunk)
            if not chunk or len(response) > 65536:
                raise RuntimeError("invalid PWA browser response boundary")
        line, extra = response.split(b"\n", 1)
        if extra:
            raise RuntimeError("invalid PWA browser response boundary")
        result = json.loads(line)
        if not isinstance(result, dict) or result.get("ok") is not True:
            gate = result.get("gate") if isinstance(result, dict) else None
            detail = (
                gate
                if isinstance(gate, str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", gate)
                else "unknown"
            )
            raise RuntimeError(f"PWA browser command failed at {detail}; inspect evidence")
        if result.get("phase") != {"close": "closed"}.get(command, command):
            raise RuntimeError("PWA browser response phase mismatch")
        return result

    def close(self) -> None:
        try:
            if self.process.poll() is None:
                self.command("close", timeout=20)
            if self.process.wait(timeout=15) != 0:
                raise RuntimeError("owned PWA browser did not exit cleanly")
        finally:
            if self.process.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=15)
            self.log.close()


def source_revision(path: Path, expected: str | None = None) -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", "-C", str(path), *args], check=True, capture_output=True, text=True
        ).stdout.strip()

    revision = git("rev-parse", "HEAD")
    if not re.fullmatch(r"[0-9a-f]{40}", revision) or (expected and revision != expected):
        raise RuntimeError("unexpected source revision")
    if git("status", "--porcelain", "--untracked-files=all"):
        raise RuntimeError("source checkout must be clean")
    return revision


def selected_config(config: dict[str, Any], images: dict[str, str]) -> dict[str, Any]:
    if set(images) != set(SERVICES) or any(
        not re.fullmatch(r"sha256:[0-9a-f]{64}", image) for image in images.values()
    ):
        raise RuntimeError("explicit retained image IDs are required")
    result: dict[str, Any] = json.loads(json.dumps(config))
    if set(result["services"]) != set(SERVICES):
        raise RuntimeError("unexpected update services")
    for name in SERVICES:
        result["services"][name].pop("build", None)
        result["services"][name].update(image=images[name], pull_policy="never")
    return result


def distinct_versions(old: dict[str, str], new: dict[str, str]) -> None:
    if any(old[name] == new[name] for name in ("backend", "frontend")):
        raise RuntimeError("old/new backend and frontend must be different images")


def running_selection(
    run: Any, compose: list[str], project: str, images: dict[str, str], volume: str
) -> None:
    for name in SERVICES:
        container = run.container(compose, name)
        if container["project"] != project or container["service"] != name:
            raise RuntimeError("unexpected update container ownership")
        image = json.loads(
            run.command(
                [*DOCKER, "inspect", "--format", "{{json .Image}}", container["id"]],
                record_output=False,
            )
        )
        run.check("selected-image-" + name, image == images[name])
        mounts = json.loads(
            run.command(
                [*DOCKER, "inspect", "--format", "{{json .Mounts}}", container["id"]],
                record_output=False,
            )
        )
        if name in ("backend", "mcp"):
            run.check(
                "same-owned-volume-" + name,
                len(mounts) == 1
                and mounts[0].get("Name") == volume
                and mounts[0].get("Destination") == "/managed-vault",
            )
        elif mounts:
            raise RuntimeError("unexpected frontend mount")
    run.recovery_volume_owner(volume, run.recovery_volumes[volume])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-source", type=Path, required=True)
    parser.add_argument(
        "--pwa", action="store_true", help="Keep a real browser across old/new images"
    )
    args = parser.parse_args(argv)
    artifact = (
        ROOT
        / ".demo/update-acceptance"
        / (datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
    )
    artifact.mkdir(parents=True)
    run = Run(artifact, secrets.token_urlsafe(32))
    project = "sb-acceptance-update-" + uuid4().hex[:12]
    result: dict[str, Any] = {
        "schema": 1,
        "status": "failed",
        "baseline": BASELINE,
        "pwa_crossversion": False,
        "production_https": False,
        "external_model_calls": False,
        "external_indexes": False,
        "phases": [],
        "cleanup_ok": False,
    }
    temporary: tempfile.TemporaryDirectory[str] | None = None
    browser: BrowserProbe | None = None

    def interrupt(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    try:
        baseline = args.baseline_source.resolve()
        result["candidate"] = source_revision(ROOT)
        source_revision(baseline, BASELINE)
        subprocess.run(
            ["git", "merge-base", "--is-ancestor", BASELINE, "HEAD"],
            cwd=ROOT,
            check=True,
            capture_output=True,
        )
        endpoint = json.loads(
            run.command(
                [
                    *DOCKER,
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
        run.command([*DOCKER, "info", "--format", "{{.ServerVersion}}"])
        temporary = tempfile.TemporaryDirectory(prefix="sb-update-")
        with contextlib.nullcontext(temporary.name) as directory:
            temp = Path(directory)
            empty = temp / "empty.env"
            empty.touch()
            configs: dict[str, Any] = {}
            images: dict[str, dict[str, str]] = {}
            for version, source in (("old", baseline), ("new", ROOT)):
                raw = json.loads(
                    run.command(
                        [
                            *DOCKER,
                            "compose",
                            "--env-file",
                            str(empty),
                            "-p",
                            project,
                            "-f",
                            str(source / "docker-compose.wiki.yml"),
                            "config",
                            "--format",
                            "json",
                        ],
                        record_output=False,
                    )
                )
                config = stack["isolated_config"](raw, project, run.key)
                for name in SERVICES:
                    config["services"][name]["image"] = f"{project}:{version}-{name}"
                path = temp / (version + ".json")
                path.write_text(json.dumps(config))
                build = [*DOCKER, "compose", "-p", project, "-f", str(path)]
                run.command([*build, "build", *SERVICES], timeout=600)
                images[version] = {
                    name: json.loads(
                        run.command(
                            [
                                *DOCKER,
                                "image",
                                "inspect",
                                "--format",
                                "{{json .Id}}",
                                config["services"][name]["image"],
                            ],
                            record_output=False,
                        )
                    )
                    for name in SERVICES
                }
                configs[version] = selected_config(config, images[version])
            distinct_versions(images["old"], images["new"])
            result["retained_images"] = images
            # Use candidate service configuration for all transitions; change only
            # image selections. Both writers are stopped before each replacement.
            config_path = temp / "running.json"
            volume = project + "_managed_wiki"
            # The Compose file must never claim deletion authority over this
            # volume, including when creation refuses or times out.
            configs["new"]["volumes"]["managed_wiki"] = {"external": True, "name": volume}
            config_path.write_text(json.dumps(selected_config(configs["new"], images["old"])))
            compose = [*DOCKER, "compose", "-p", project, "-f", str(config_path)]
            run.create_recovery_volume(volume)
            result["volume"] = volume
            run.projects.append(compose)
            create = {
                "markdown": "# Update notebook\nOnly invented observations.",
                "base_revision": None,
                "request_id": "update-create",
            }
            receipts: list[tuple[dict[str, Any], dict[str, Any]]] = []
            page: dict[str, Any] | None = None
            history: dict[str, Any] | None = None
            worker_bytes: list[bytes] = []
            for phase, version in (
                ("baseline", "old"),
                ("forward", "new"),
                ("rollback", "old"),
                ("resume", "new"),
            ):
                if receipts:
                    run.command([*compose, "stop", *SERVICES])
                config_path.write_text(json.dumps(selected_config(configs["new"], images[version])))
                run.command(
                    [*compose, "up", "-d", "--no-build", "--pull", "never", "--wait"], timeout=150
                )
                running_selection(run, compose, project, images[version], volume)
                base = run.port(compose, "frontend", 80)
                mcp = run.port(compose, "mcp", 3001) + "/mcp"
                run.wait(base + "/api/wiki/health")
                run.initialize(mcp)
                url = base + "/api/wiki/pages/update-notebook"
                worker_bytes.append(run.http(base + "/service-worker.js")[0])
                if args.pwa and phase == "forward":
                    run.check("actual-worker-version-changed", worker_bytes[0] != worker_bytes[1])
                    assert browser is not None
                    result["pwa_forward"] = browser.command("forward", upstream=base)
                    browser.close()
                    browser = None
                    result["pwa_crossversion"] = True
                if page is not None:
                    run.check(phase + "-page", run.data(url) == page)
                    run.check(phase + "-history", run.data(url + "/history") == history)
                # Replay every prior request across both transport implementations.
                for payload, receipt in receipts:
                    run.check(phase + "-rest-retry", run.data(url, body=payload) == receipt)
                    retry = run.rpc(
                        mcp,
                        "tools/call",
                        {
                            "name": "save_page",
                            "arguments": {
                                **payload,
                                "id": "update-notebook",
                            },
                        },
                    )
                    run.check(phase + "-mcp-retry", retry["structuredContent"] == receipt)
                if receipts:
                    run.data(url, body={**create, "request_id": phase + "-stale"}, expected=409)
                    run.check(
                        phase + "-retry-no-extra-history", run.data(url + "/history") == history
                    )
                if phase != "resume":
                    payload = (
                        create
                        if page is None
                        else {
                            "markdown": page["markdown"] + "\nObserved " + phase + ".",
                            "base_revision": page["revision"],
                            "request_id": "update-" + phase,
                        }
                    )
                    if phase == "rollback":
                        write = run.rpc(
                            mcp,
                            "tools/call",
                            {
                                "name": "save_page",
                                "arguments": {
                                    **payload,
                                    "id": "update-notebook",
                                },
                            },
                        )
                        run.check("rollback-mcp-write", not write.get("isError", False))
                        receipt = write["structuredContent"]
                    else:
                        receipt = run.data(url, body=payload)
                    receipts.append((payload, receipt))
                    page = run.data(url)
                    run.check(
                        phase + "-write-visible",
                        page["revision"] == receipt["revision"]
                        and page["markdown"] == payload["markdown"],
                    )
                    history = run.data(url + "/history")
                    run.check(phase + "-history-count", len(history["history"]) == len(receipts))
                result["phases"].append(
                    {"phase": phase, "images": images[version], "history_count": len(receipts)}
                )
                if args.pwa and phase == "baseline":
                    run.data(
                        base + "/api/wiki/pages/pwa-update-notebook",
                        body={
                            "markdown": "# PWA update notebook\nOnly invented observations.",
                            "base_revision": None,
                            "request_id": "pwa-update-create",
                        },
                    )
                    browser = BrowserProbe(ROOT, artifact, run.env)
                    result["pwa_baseline"] = browser.command(
                        "baseline", upstream=base, page_id="pwa-update-notebook"
                    )
            result.update(status="passed", worker_bytes_changed=worker_bytes[0] != worker_bytes[1])
    except (Exception, KeyboardInterrupt) as exc:
        result["failure"] = (type(exc).__name__ + ": " + str(exc)).replace(run.key, "[redacted]")
        for compose in run.projects:
            run.diagnostics(compose, "image-update-failure")
    finally:
        clean = True
        if browser is not None:
            try:
                browser.close()
            except Exception:
                clean = False
        for compose in reversed(run.projects):
            with contextlib.suppress(Exception):
                run.command([*compose, "logs", "--no-color"], timeout=30)
            try:
                run.command([*compose, "down", "--volumes", "--remove-orphans"], timeout=90)
            except Exception:
                clean = False
        for volume in list(run.recovery_volumes):
            try:
                run.cleanup_recovery_volume(volume)
            except Exception:
                clean = False
        if clean and temporary is not None:
            temporary.cleanup()
        result["cleanup_ok"] = clean
        if not clean:
            result["status"] = "failed"
        result["gates"] = run.steps
        result["finished_at"] = datetime.now(UTC).isoformat()
        (artifact / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Managed image update {result['status']}. Evidence: {artifact / 'result.json'}")
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
