"""Run the disposable real-service wiki acceptance suite end to end."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import OpenerDirector, ProxyHandler, build_opener


def _wait_for_http(
    url: str,
    process: subprocess.Popen[bytes],
    *,
    timeout: float,
    opener: OpenerDirector | None = None,
) -> None:
    """Wait for one local endpoint while also watching the service supervisor."""
    client = opener or build_opener(ProxyHandler({}))
    deadline = time.monotonic() + timeout
    last_error = "not contacted"
    while time.monotonic() < deadline:
        status = process.poll()
        if status is not None:
            raise RuntimeError(f"demo services exited with status {status}")
        try:
            with client.open(url, timeout=2) as response:
                if 200 <= response.status < 400:
                    return
                last_error = f"HTTP {response.status}"
        except (OSError, URLError) as exc:
            last_error = str(exc)
        time.sleep(0.25)
    raise RuntimeError(f"timed out waiting for {url}: {last_error}")


def _stop_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=10)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)


def _git_head(root: Path) -> str | None:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else None


def _tail(path: Path, lines: int = 30) -> str:
    try:
        return "\n".join(
            path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:]
        )
    except OSError:
        return ""


def main(argv: Sequence[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=60,
        help="Seconds to wait for the local API and frontend (default: 60)",
    )
    parser.add_argument(
        "--keep-vault",
        action="store_true",
        help="Retain the disposable mutated vault after a successful run",
    )
    parser.add_argument(
        "--first-start",
        action="store_true",
        help="Check an empty wiki, then restart both services and verify persisted pages",
    )
    args = parser.parse_args(argv)
    if args.startup_timeout <= 0:
        parser.error("--startup-timeout must be positive")

    run_id = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    artifact_dir = root / ".demo" / "acceptance" / run_id
    suffix = 1
    while artifact_dir.exists():
        artifact_dir = root / ".demo" / "acceptance" / f"{run_id}-{suffix}"
        suffix += 1
    artifact_dir.mkdir(parents=True)
    vault = artifact_dir / "vault"
    service_log = artifact_dir / "services.log"
    browser_log = artifact_dir / "browser.log"
    result_path = artifact_dir / "result.json"
    started = datetime.now(UTC)
    status = "failed"
    failure: str | None = None
    browser_status: int | None = None
    browser_phases: list[dict[str, Any]] = []
    service_starts = 0
    supervisor: subprocess.Popen[bytes] | None = None

    env = {**os.environ}
    env.pop("OPENROUTER_API_KEY", None)
    command = [
        sys.executable,
        str(root / "scripts" / "run-wiki-demo.py"),
        "--vault",
        str(vault),
    ]
    suites = (
        ["e2e/first-start.spec.ts"]
        if args.first_start
        else [
            "e2e/wiki.spec.ts",
            "e2e/history.spec.ts",
            "e2e/skip-link.spec.ts",
            "e2e/article-focus.spec.ts",
        ]
    )
    phases = ("create", "restart") if args.first_start else ("demo",)
    browser_command = ["npm", "run", "test:browser", "--", *suites]
    if args.first_start:
        command.append("--empty")
        env.update(
            PLAYWRIGHT_FIRST_START="1",
            PLAYWRIGHT_FIRST_START_STATE=str(artifact_dir / "browser-state.json"),
            PLAYWRIGHT_FIRST_START_RECEIPT=str(artifact_dir / "pages.json"),
        )

    try:
        for phase in phases:
            phase_env = {**env, "PLAYWRIGHT_FIRST_START_PHASE": phase}
            phase_command = browser_command
            if args.first_start:
                # Preserve each phase's images and the ordinary suite's output.
                phase_command = [
                    *browser_command,
                    "--output",
                    str(artifact_dir / f"browser-{phase}"),
                ]
            with service_log.open("ab") as services:
                supervisor = subprocess.Popen(
                    command,
                    cwd=root,
                    env=phase_env,
                    stdout=services,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                service_starts += 1
                _wait_for_http(
                    "http://127.0.0.1:8000/api/wiki/health",
                    supervisor,
                    timeout=args.startup_timeout,
                )
                _wait_for_http(
                    "http://127.0.0.1:5173/",
                    supervisor,
                    timeout=args.startup_timeout,
                )
                with browser_log.open("ab") as browser:
                    browser.write(f"\nAcceptance phase: {phase}\n".encode())
                    browser.flush()
                    completed = subprocess.run(
                        phase_command,
                        cwd=root / "frontend",
                        env=phase_env,
                        stdout=browser,
                        stderr=subprocess.STDOUT,
                        check=False,
                    )
                browser_status = completed.returncode
                browser_phases.append(
                    {
                        "phase": phase,
                        "exit_code": browser_status,
                        "supervisor_pid": supervisor.pid,
                    }
                )
                if browser_status != 0:
                    raise RuntimeError(
                        f"{phase} browser suite exited with status {browser_status}"
                    )
                # Stop and reap the real API/Vite supervisor before starting
                # the next phase on the same owned, persistent vault.
                _stop_process_group(supervisor)
                supervisor = None
        status = "passed"
    except (OSError, RuntimeError) as exc:
        failure = str(exc)
    finally:
        if supervisor is not None:
            _stop_process_group(supervisor)

    keep_vault = args.keep_vault or status != "passed"
    if not keep_vault:
        try:
            shutil.rmtree(vault)
            for name in ("browser-state.json", "pages.json"):
                (artifact_dir / name).unlink(missing_ok=True)
        except OSError as exc:
            status = "failed"
            failure = f"owned acceptance inputs could not be removed: {exc}"
    # Record observed cleanup, rather than merely the requested retention policy.
    keep_vault = vault.exists()
    phase_inputs_retained = any(
        (artifact_dir / name).exists() for name in ("browser-state.json", "pages.json")
    )
    finished = datetime.now(UTC)
    evidence: dict[str, Any] = {
        "schema": 1,
        "status": status,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "duration_seconds": round((finished - started).total_seconds(), 3),
        "git_head": _git_head(root),
        "suite": f"frontend/{suites[0]}",
        "suites": [f"frontend/{suite}" for suite in suites],
        "fixture": "empty-first-start" if args.first_start else "fictional-template",
        "services": [
            "http://127.0.0.1:8000/api/wiki/health",
            "http://127.0.0.1:5173/",
        ],
        "external_model_calls": False,
        "browser_exit_code": browser_status,
        "browser_phases": browser_phases,
        "service_restarts": max(0, service_starts - 1),
        "vault_retained": keep_vault,
        "phase_inputs_retained": phase_inputs_retained,
        "failure": failure,
    }
    result_path.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
    print(f"Acceptance {status}. Evidence: {result_path}")
    if status != "passed":
        service_tail = _tail(service_log)
        browser_tail = _tail(browser_log)
        if service_tail:
            print(f"\nService log tail:\n{service_tail}", file=sys.stderr)
        if browser_tail:
            print(f"\nBrowser log tail:\n{browser_tail}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
