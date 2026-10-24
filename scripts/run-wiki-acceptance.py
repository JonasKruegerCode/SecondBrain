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


def _stop_process_group(
    process: subprocess.Popen[bytes], process_state: Path | None = None
) -> None:
    groups: list[int] = []
    failed = False
    if process_state is not None:
        try:
            record = json.loads(process_state.read_text(encoding="utf-8"))
            candidate = record["process_group_ids"]
            if (
                record["supervisor_pid"] != process.pid
                or not isinstance(candidate, list)
                or len(candidate) > 2
                or any(
                    type(pid) is not int
                    or not 1 < pid <= 2_147_483_647
                    or pid in (process.pid, os.getpgrp())
                    for pid in candidate
                )
                or len(set(candidate)) != len(candidate)
            ):
                raise ValueError("Invalid owned process record")
            groups = candidate
            failed = record.get("launch_complete") is not True or len(groups) != 2
        except (OSError, ValueError, KeyError, TypeError):
            failed = True
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    except OSError:
        failed = True
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        failed = True
    # The launcher can die before its finally block. Its two separate sessions
    # are recorded before browser work; never infer their exit from its PID.
    for group in [process.pid, *groups]:
        for signum in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(group, signum)
            except ProcessLookupError:
                pass
            except OSError:
                failed = True
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        failed = True
    if process.returncode != 0:
        failed = True
    if failed:
        raise RuntimeError("Owned demo service cleanup could not be confirmed.")


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
    parser.add_argument(
        "--scale",
        action="store_true",
        help="Run the bounded Chromium scale suite with a fresh synthetic 320-page vault",
    )
    parser.add_argument(
        "--browser-grep",
        help="Run only matching browser tests for diagnosis; not a full acceptance run",
    )
    parser.add_argument(
        "--browser-engine",
        choices=("chromium", "webkit"),
        default="chromium",
        help="Chromium full suite or WebKit reading/navigation compatibility slice",
    )
    parser.add_argument(
        "--webkit-workers",
        action="store_true",
        help="Separate WebKit worker/update slice with service workers enabled",
    )
    parser.add_argument(
        "--webkit-first-install-diagnostic",
        action="store_true",
        help="Diagnose only WebKit first installation; 1–20 repeats, not full acceptance",
    )
    parser.add_argument(
        "--repeat-each",
        type=int,
        default=1,
        help="Repeat each selected test for bounded intermittent-failure diagnosis",
    )
    args = parser.parse_args(argv)
    if args.startup_timeout <= 0:
        parser.error("--startup-timeout must be positive")
    if args.repeat_each < 1:
        parser.error("--repeat-each must be positive")
    if args.scale and (
        args.first_start
        or args.browser_engine != "chromium"
        or args.webkit_workers
        or args.webkit_first_install_diagnostic
        or args.browser_grep is not None
        or args.repeat_each != 1
    ):
        parser.error(
            "--scale requires its unfiltered, unrepeated Chromium acceptance profile"
        )
    if args.first_start and (args.browser_grep or args.repeat_each != 1):
        parser.error("first-start phases cannot be filtered or repeated")
    if args.first_start and args.browser_engine != "chromium":
        parser.error("first-start phases require the Chromium acceptance profile")
    if args.webkit_workers and (
        args.browser_engine != "webkit"
        or args.first_start
        or args.browser_grep
        or args.repeat_each != 1
    ):
        parser.error("--webkit-workers requires unfiltered WebKit worker acceptance")
    if args.webkit_first_install_diagnostic and (
        args.browser_engine != "webkit"
        or args.first_start
        or args.webkit_workers
        or args.browser_grep
        or args.repeat_each > 20
    ):
        parser.error(
            "first-install diagnosis requires WebKit, its fixed case and 1–20 repeats"
        )

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
    process_state: Path | None = None
    service_cleanup_ok = True

    env = {**os.environ}
    # Nested delivery fixtures need the interpreter running this acceptance,
    # including Poetry environments outside backend/.venv. Honor an override.
    env["WIKI_PYTHON"] = env.get("WIKI_PYTHON") or sys.executable
    env.pop("OPENROUTER_API_KEY", None)
    env["PLAYWRIGHT_BROWSER_ENGINE"] = args.browser_engine
    command = [
        sys.executable,
        str(root / "scripts" / "run-wiki-demo.py"),
        "--vault",
        str(vault),
    ]
    if args.scale:
        command.extend(["--scale-pages", "320"])
        env["PLAYWRIGHT_SCALE"] = "1"
    suites = (
        ["e2e/first-start.spec.ts"]
        if args.first_start
        else [
            "e2e/wiki.spec.ts",
            "e2e/curated-home.spec.ts",
            "e2e/pwa-existing-install.spec.ts",
            "e2e/history.spec.ts",
            "e2e/delivery-recovery.spec.ts",
            "e2e/skip-link.spec.ts",
            "e2e/article-focus.spec.ts",
            "e2e/view-focus.spec.ts",
            "e2e/text-enlargement.spec.ts",
            "e2e/start-preference.spec.ts",
            "e2e/demo-rehearsal.spec.ts",
            "e2e/galaxy-density.spec.ts",
            "e2e/article-galaxy.spec.ts",
            "e2e/galaxy-search.spec.ts",
            "e2e/editor-retry.spec.ts",
            "e2e/editor-incarnation.spec.ts",
            "e2e/resolve-identity.spec.ts",
            "e2e/markdown-lists.spec.ts",
            "e2e/code-reading.spec.ts",
            "e2e/image-reading.spec.ts",
            "e2e/unicode-navigation.spec.ts",
            "e2e/title-identity.spec.ts",
            "e2e/title-promotion.spec.ts",
            "e2e/title-inline.spec.ts",
            "e2e/inline-wrapper.spec.ts",
            "e2e/script-exclusion.spec.ts",
            "e2e/chat-concurrency.spec.ts",
            "e2e/chat-history.spec.ts",
            "e2e/forced-colors.spec.ts",
        ]
    )
    if args.scale:
        suites = ["e2e/scale.spec.ts"]
    if args.browser_engine == "webkit":
        suites = [
            "e2e/curated-home.spec.ts",
            "e2e/skip-link.spec.ts",
            "e2e/history.spec.ts",
            "e2e/delivery-recovery.spec.ts",
            "e2e/article-focus.spec.ts",
            "e2e/view-focus.spec.ts",
            "e2e/text-enlargement.spec.ts",
            "e2e/start-preference.spec.ts",
            "e2e/demo-rehearsal.spec.ts",
            "e2e/galaxy-density.spec.ts",
            "e2e/article-galaxy.spec.ts",
            "e2e/galaxy-search.spec.ts",
            "e2e/editor-retry.spec.ts",
            "e2e/editor-incarnation.spec.ts",
            "e2e/resolve-identity.spec.ts",
            "e2e/markdown-lists.spec.ts",
            "e2e/code-reading.spec.ts",
            "e2e/image-reading.spec.ts",
            "e2e/unicode-navigation.spec.ts",
            "e2e/title-identity.spec.ts",
            "e2e/title-promotion.spec.ts",
            "e2e/title-inline.spec.ts",
            "e2e/inline-wrapper.spec.ts",
            "e2e/script-exclusion.spec.ts",
            "e2e/chat-concurrency.spec.ts",
            "e2e/chat-history.spec.ts",
        ]
    worker_filter = (
        "(PWA metadata registers an online-only worker without private caches|"
        "PWA offers and applies a waiting worker update|"
        "PWA discovers an update already installing when a new tab opens [(](390|1440)[)]|"
        "PWA background update failures remain recoverable [(](390|1440)[)]|"
        "PWA preserves a dirty tab when another tab updates, "
        "then permits (save|discard) and reload)$"
        if args.webkit_workers
        else None
    )
    if args.webkit_first_install_diagnostic:
        # Playwright prefixes its grep title with the file/project name.
        worker_filter = (
            "PWA metadata registers an online-only worker without private caches$"
        )
    if args.webkit_workers or args.webkit_first_install_diagnostic:
        suites = ["e2e/wiki.spec.ts"]
        if args.webkit_workers:
            suites.append("e2e/pwa-existing-install.spec.ts")
    phases = (
        ("create", "restart")
        if args.first_start
        else (("scale",) if args.scale else ("demo",))
    )
    browser_command = ["npm", "run", "test:browser", "--", *suites]
    if args.browser_grep:
        browser_command.extend(["--grep", args.browser_grep])
    if worker_filter:
        browser_command.extend(["--grep", worker_filter])
    if args.repeat_each != 1:
        browser_command.extend(["--repeat-each", str(args.repeat_each)])
    output_name = "browser-chromium"
    if args.scale:
        output_name = "browser-scale"
    elif args.browser_engine == "webkit":
        output_name = "browser-webkit"
        if args.webkit_workers:
            output_name = "browser-webkit-workers"
        if args.webkit_first_install_diagnostic:
            output_name = "browser-webkit-first-install-diagnostic"
    elif args.browser_grep or args.repeat_each != 1:
        output_name = "browser-diagnostic"
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
            process_state = artifact_dir / f"processes-{phase}.json"
            # Playwright clears its output directory before running. Every run
            # and first-start phase must retain its own failure evidence.
            phase_output = f"browser-{phase}" if args.first_start else output_name
            phase_command = [
                *browser_command, "--output", str(artifact_dir / phase_output),
            ]
            with service_log.open("ab") as services:
                supervisor = subprocess.Popen(
                    [*command, "--process-state", str(process_state)],
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
                _stop_process_group(supervisor, process_state)
                supervisor = None
        status = "passed"
    except (OSError, RuntimeError) as exc:
        failure = str(exc)
    finally:
        if supervisor is not None:
            try:
                _stop_process_group(supervisor, process_state)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                service_cleanup_ok = False
                status = "failed"
                failure = f"{failure + '; ' if failure else ''}{exc}"

    keep_vault = args.keep_vault or status != "passed"
    if not keep_vault:
        try:
            shutil.rmtree(vault)
            for name in (
                "browser-state.json",
                "pages.json",
                *[f"processes-{phase}.json" for phase in phases],
            ):
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
        "browser_engine": args.browser_engine,
        "browser_profile": "scale"
        if args.scale
        else (
            "first-install-diagnostic"
            if args.webkit_first_install_diagnostic
            else (
                "worker-update"
                if args.webkit_workers
                else (
                    "reading-navigation" if args.browser_engine == "webkit" else "full"
                )
            )
        ),
        "service_workers": "block"
        if (
            args.browser_engine == "webkit"
            and not (args.webkit_workers or args.webkit_first_install_diagnostic)
        )
        else "allow",
        "suite": f"frontend/{suites[0]}",
        "suites": [f"frontend/{suite}" for suite in suites],
        "test_selection": {
            "grep": worker_filter or args.browser_grep,
            "repeat_each": args.repeat_each,
        },
        "fixture": "synthetic-scale-320"
        if args.scale
        else ("empty-first-start" if args.first_start else "fictional-template"),
        "services": [
            "http://127.0.0.1:8000/api/wiki/health",
            "http://127.0.0.1:5173/",
        ],
        "external_model_calls": False,
        "browser_exit_code": browser_status,
        "browser_phases": browser_phases,
        "service_restarts": max(0, service_starts - 1),
        "service_cleanup_ok": service_cleanup_ok,
        "process_records_retained": any(artifact_dir.glob("processes-*.json*")),
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


