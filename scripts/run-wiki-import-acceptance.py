"""Exercise explicit local-Git first start through real setup, API and browsers.

Only runner-owned repositories made from the public fictional fixture are used.
No remote Git, hosted index or model access is configured. Source repositories,
vaults, browser state and page receipts are never public CI artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.request import ProxyHandler, build_opener


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep-vault", action="store_true")
    args = parser.parse_args()
    parent = root / ".demo" / "acceptance"
    parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    directory = Path(tempfile.mkdtemp(prefix=f"{stamp}-git-import-", dir=parent))
    source = directory / "source"
    empty_source = directory / "empty-source"
    vault = directory / "vault"
    empty_vault = directory / "empty-vault"
    inputs = directory / "import-inputs.json"
    receipt = directory / "import-receipt.json"
    state = directory / "browser-state.json"
    helpers = runpy.run_path(str(root / "scripts" / "run-wiki-acceptance.py"))
    started = datetime.now(UTC)
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    env.pop("OPENROUTER_API_KEY", None)
    env.update(
        PYTHONPATH=str(root / "backend" / "src"),
        PLAYWRIGHT_GIT_IMPORT="1",
        PLAYWRIGHT_GIT_IMPORT_INPUTS=str(inputs),
        PLAYWRIGHT_GIT_IMPORT_RECEIPT=str(receipt),
        PLAYWRIGHT_GIT_IMPORT_STATE=str(state),
    )
    phases: list[dict[str, Any]] = []
    checks: dict[str, bool] = {}
    supervisor: subprocess.Popen[bytes] | None = None
    process_state: Path | None = None
    service_cleanup_ok = True
    failure: str | None = None
    status = "failed"
    client = build_opener(ProxyHandler({}))

    def run(command: list[str], *, cwd: Path = root, refused: bool = False) -> str:
        result = subprocess.run(
            command, cwd=cwd, env=env, capture_output=True, text=True, check=False
        )
        if (result.returncode == 0) == refused:
            raise RuntimeError(
                f"Unexpected command outcome: {command[0]}: {result.stderr}"
            )
        return result.stdout

    def git(path: Path, *arguments: str) -> str:
        return run(
            [
                "git",
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Synthetic import fixture",
                "-c",
                "user.email=fixture@example.invalid",
                *arguments,
            ],
            cwd=path,
        ).strip()

    def setup(
        target: Path, source_path: Path, request: str, *, refused: bool = False
    ) -> dict[str, Any]:
        command = [
            sys.executable,
            "-m",
            "second_brain.wiki.setup",
            "--vault",
            str(target),
            "--mode",
            "import",
            "--source",
            str(source_path),
            "--request-id",
            request,
        ]
        if source_path == source:
            command.extend(["--prefix", "wiki"])
        output = run(command, refused=refused)
        return {} if refused else json.loads(output)

    def unchanged() -> dict[str, Any]:
        return {
            "head": git(source, "rev-parse", "HEAD"),
            "status": git(source, "status", "--porcelain"),
            "files": {
                path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted((source / "wiki").glob("*.md"))
            },
        }

    def get(path: str) -> Any:
        with client.open(
            f"http://127.0.0.1:8000/api/wiki{path}", timeout=10
        ) as response:
            return json.load(response)

    def capture() -> dict[str, Any]:
        pages = []
        for entry in sorted(get("/pages")["pages"], key=lambda item: item["id"]):
            page = get(f"/pages/{entry['id']}")
            pages.append({key: page[key] for key in ("id", "markdown", "revision")})
        return {
            "pages": pages,
            "history": get("/pages/night-sky-survey/history")["history"],
            "graph": get("/graph"),
        }

    def require(condition: bool, message: str) -> None:
        if not condition:
            raise RuntimeError(message)

    try:
        source.mkdir()
        empty_source.mkdir()
        git(source, "init", "--quiet", "--initial-branch=fixture")
        git(empty_source, "init", "--quiet", "--initial-branch=fixture")
        (source / "wiki").mkdir()
        for path in sorted((root / "examples" / "demo-vault").glob("*.md")):
            shutil.copyfile(path, source / "wiki" / path.name)
        require(
            len(list((source / "wiki").glob("*.md"))) == 12,
            "Expected public twelve-page atlas",
        )
        git(source, "add", "wiki")
        git(source, "commit", "--quiet", "-m", "Synthetic atlas source")
        initial_source = git(source, "rev-parse", "HEAD")
        survey = source / "wiki" / "night-sky-survey.md"
        survey.write_text(
            survey.read_text(encoding="utf-8")
            + "\nSynthetic import verification: synthetic-import-marker.\n",
            encoding="utf-8",
        )
        git(source, "add", "wiki/night-sky-survey.md")
        git(source, "commit", "--quiet", "-m", "Update synthetic import survey")
        baseline = unchanged()
        source_commits = [initial_source, baseline["head"]]
        require(not baseline["status"], "Fixture source must be clean")

        first_empty = setup(empty_vault, empty_source, "synthetic-empty-import")
        require(
            first_empty["pages"] == 0 and first_empty["source_revision"] is None,
            "Empty import seeded content",
        )
        require(
            setup(empty_vault, empty_source, "synthetic-empty-import") == first_empty,
            "Empty retry changed publication",
        )
        checks["empty_import_idempotent"] = True
        first = setup(vault, source, "synthetic-atlas-import")
        require(
            first["pages"] == 12 and first["source_revision"] == baseline["head"],
            "Wrong imported source",
        )
        require(
            setup(vault, source, "synthetic-atlas-import") == first,
            "Initial retry changed publication",
        )
        checks["initial_import_idempotent"] = True

        for phase, target in (
            ("empty", empty_vault),
            ("import", vault),
            ("restart", vault),
        ):
            if phase == "restart":
                repeated = setup(vault, source, "synthetic-atlas-import")
                require(
                    repeated["revision"] == first["revision"],
                    "Retry lost original import receipt",
                )
                require(
                    repeated["current_revision"] != first["revision"],
                    "Browser edit did not publish",
                )
                setup(vault, source, "different-first-start-request", refused=True)
                setup(vault, empty_source, "empty-over-existing", refused=True)
                run(
                    [
                        sys.executable,
                        "-m",
                        "second_brain.wiki.setup",
                        "--vault",
                        str(vault),
                        "--mode",
                        "template",
                    ],
                    refused=True,
                )
                checks["new_first_start_and_empty_import_refused"] = True
                checks["template_refused_existing_contents"] = True
            phase_env = {**env, "PLAYWRIGHT_GIT_IMPORT_PHASE": phase}
            process_state = directory / f"processes-{phase}.json"
            with (directory / "services.log").open("ab") as services:
                # Intentionally use the normal launcher without --empty: an
                # already initialized imported vault must never be auto-seeded.
                supervisor = subprocess.Popen(
                    [
                        sys.executable,
                        str(root / "scripts" / "run-wiki-demo.py"),
                        "--vault",
                        str(target),
                        "--process-state",
                        str(process_state),
                    ],
                    cwd=root,
                    env=phase_env,
                    stdout=services,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
                helpers["_wait_for_http"](
                    "http://127.0.0.1:8000/api/wiki/health", supervisor, timeout=60
                )
                helpers["_wait_for_http"](
                    "http://127.0.0.1:5173/", supervisor, timeout=60
                )
                if phase == "import":
                    imported = capture()
                    require(
                        {page["id"] for page in imported["pages"]}
                        == {Path(name).stem for name in baseline["files"]},
                        "Unexpected imported IDs",
                    )
                    require(
                        all(
                            page["markdown"]
                            == (source / "wiki" / f"{page['id']}.md").read_text(
                                encoding="utf-8"
                            )
                            for page in imported["pages"]
                        ),
                        "Imported Markdown differs from committed source",
                    )
                    require(
                        set(source_commits).issubset(
                            {entry["commit"] for entry in imported["history"]}
                        ),
                        "Original history missing",
                    )
                    inputs.write_text(
                        json.dumps({**imported, "source_commits": source_commits}),
                        encoding="utf-8",
                    )
                    checks["original_history_retained"] = True
                elif phase == "restart":
                    require(
                        capture() == json.loads(receipt.read_text(encoding="utf-8")),
                        "Retry/restart overwrote browser edits",
                    )
                    checks["retry_restart_preserves_browser_edit"] = True
                with (directory / "browser.log").open("ab") as browser:
                    browser.write(f"\nImport acceptance phase: {phase}\n".encode())
                    browser.flush()
                    completed = subprocess.run(
                        [
                            "npm",
                            "run",
                            "test:browser",
                            "--",
                            "e2e/git-import.spec.ts",
                            "--output",
                            str(directory / f"browser-{phase}"),
                        ],
                        cwd=root / "frontend",
                        env=phase_env,
                        stdout=browser,
                        stderr=subprocess.STDOUT,
                        check=False,
                    )
                phases.append(
                    {
                        "phase": phase,
                        "exit_code": completed.returncode,
                        "supervisor_pid": supervisor.pid,
                    }
                )
                require(completed.returncode == 0, f"{phase} browser check failed")
                helpers["_stop_process_group"](supervisor, process_state)
                supervisor = None
            require(
                unchanged() == baseline,
                "Import or browser operation changed the source",
            )
        checks["source_unchanged"] = True
        status = "passed"
    except (OSError, RuntimeError) as exc:
        failure = str(exc)
    finally:
        if supervisor is not None:
            try:
                helpers["_stop_process_group"](supervisor, process_state)
            except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
                service_cleanup_ok = False
                status = "failed"
                failure = f"{failure + '; ' if failure else ''}{exc}"

    if status == "passed" and not args.keep_vault:
        try:
            for path in (source, empty_source, vault, empty_vault):
                shutil.rmtree(path)
            for path in (inputs, receipt, state, *directory.glob("processes-*.json")):
                path.unlink(missing_ok=True)
        except OSError as exc:
            status, failure = (
                "failed",
                f"Owned import inputs could not be removed: {exc}",
            )
    result = {
        "schema": 1,
        "status": status,
        "started_at": started.isoformat(),
        "finished_at": datetime.now(UTC).isoformat(),
        "duration_seconds": round((datetime.now(UTC) - started).total_seconds(), 3),
        "git_head": helpers["_git_head"](root),
        "fixture": "synthetic-local-git-import",
        "suite": "frontend/e2e/git-import.spec.ts",
        "browser_phases": phases,
        "service_restarts": int(any(phase["phase"] == "restart" for phase in phases)),
        "service_cleanup_ok": service_cleanup_ok,
        "process_records_retained": any(directory.glob("processes-*.json*")),
        "checks": checks,
        "external_model_calls": False,
        "vault_retained": any(path.exists() for path in (vault, empty_vault)),
        "source_retained": any(path.exists() for path in (source, empty_source)),
        "phase_inputs_retained": any(
            path.exists() for path in (inputs, receipt, state)
        ),
        "failure": failure,
    }
    (directory / "result.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Git import acceptance {status}. Evidence: {directory / 'result.json'}")
    if status != "passed":
        print(failure, file=sys.stderr)
        print(helpers["_tail"](directory / "browser.log"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
