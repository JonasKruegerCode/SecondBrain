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
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
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
    supervisor: subprocess.Popen[bytes] | None = None

    env = {**os.environ}
    env.pop("OPENROUTER_API_KEY", None)
    command = [
        sys.executable,
        str(root / "scripts" / "run-wiki-demo.py"),
        "--vault",
        str(vault),
    ]
    browser_command = ["npm", "run", "test:browser", "--", "e2e/wiki.spec.ts"]

    try:
        with service_log.open("wb") as services:
            supervisor = subprocess.Popen(
                command,
                cwd=root,
                env=env,
                stdout=services,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
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
            with browser_log.open("wb") as browser:
                completed = subprocess.run(
                    browser_command,
                    cwd=root / "frontend",
                    env=env,
                    stdout=browser,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
            browser_status = completed.returncode
            if browser_status != 0:
                raise RuntimeError(f"browser suite exited with status {browser_status}")
            status = "passed"
    except (OSError, RuntimeError) as exc:
        failure = str(exc)
    finally:
        if supervisor is not None:
            _stop_process_group(supervisor)

    keep_vault = args.keep_vault or status != "passed"
    if not keep_vault:
        shutil.rmtree(vault, ignore_errors=True)
    finished = datetime.now(UTC)
    evidence: dict[str, Any] = {
        "schema": 1,
        "status": status,
        "started_at": started.isoformat(),
        "finished_at": finished.isoformat(),
        "duration_seconds": round((finished - started).total_seconds(), 3),
        "git_head": _git_head(root),
        "suite": "frontend/e2e/wiki.spec.ts",
        "services": [
            "http://127.0.0.1:8000/api/wiki/health",
            "http://127.0.0.1:5173/",
        ],
        "external_model_calls": False,
        "browser_exit_code": browser_status,
        "vault_retained": keep_vault,
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
