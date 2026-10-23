"""Start an isolated real-content demo; no remote Git or LLM is required."""

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path

from second_brain.wiki.demo import FORMAT_VERSION, MARKER, seed_vault
from second_brain.wiki.scale_demo import create_scale_vault


def _wait_for_children(
    children: Sequence[subprocess.Popen[bytes]], *, poll_interval: float = 0.25
) -> int:
    """Return nonzero when either long-running service exits unexpectedly."""
    while True:
        statuses = [child.poll() for child in children]
        if any(status is not None for status in statuses):
            failed = next((status for status in statuses if status not in (None, 0)), None)
            return failed if failed is not None else 1
        time.sleep(poll_interval)


def _stop_children(children: Sequence[subprocess.Popen[bytes]], *, grace_seconds: float = 5) -> None:
    failed = False
    for child in children:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            failed = True
    for child in children:
        try:
            child.wait(timeout=grace_seconds)
        except subprocess.TimeoutExpired:
            pass
        # The wrapper can exit before its descendants. Finish the owned group
        # even when the leader is already reaped, then reap any killed leader.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except OSError:
            failed = True
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            failed = True
    if failed:
        raise RuntimeError("Could not stop all owned demo process groups.")


def _record_processes(path: Path | None, children: Sequence[subprocess.Popen[bytes]],
                      *, complete: bool) -> None:
    if path is None:
        return
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps({
        "supervisor_pid": os.getpid(),
        "process_group_ids": [child.pid for child in children],
        "launch_complete": complete,
    }), encoding="utf-8")
    temporary.replace(path)


def _require_completed_seed(vault: Path) -> None:
    """Do not mistake a partial seed's Git directory for a finished demo."""
    path = vault / MARKER
    if not path.exists() and not path.is_symlink():
        return  # Empty and imported managed vaults need no demo marker.
    try:
        if not path.is_file() or path.is_symlink():
            raise ValueError("unsafe marker")
        marker = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(marker, dict)
            or marker.get("format") != FORMAT_VERSION
            or marker.get("state") not in ("seeding", "complete")
        ):
            raise ValueError("invalid marker")
    except (OSError, ValueError) as exc:
        raise SystemExit(
            "Demo marker is invalid or unreadable; inspect or restore it before starting."
        ) from exc
    if marker["state"] == "seeding":
        raise SystemExit(
            "Demo seed is unfinished. Use the explicit --resume setup procedure with "
            "the same template before starting services. --empty does not finish a seed."
        )
    repository = vault / ".wiki.git"
    if not repository.is_dir() or repository.is_symlink():
        raise SystemExit("Completed demo repository is missing or unsafe; inspect or restore it.")


def main(argv: Sequence[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path)
    parser.add_argument("--process-state", type=Path, help=argparse.SUPPRESS)
    start = parser.add_mutually_exclusive_group()
    start.add_argument("--empty", action="store_true", help="Start without the fictional template")
    start.add_argument(
        "--scale-pages",
        type=int,
        metavar="COUNT",
        help="Create a fresh disposable large synthetic vault before starting",
    )
    parser.add_argument(
        "--with-openrouter",
        action="store_true",
        help="Allow the chat to use the explicitly configured OPENROUTER_API_KEY",
    )
    args = parser.parse_args(argv)
    if args.process_state and (args.process_state.exists() or
                              args.process_state.with_name(args.process_state.name + ".tmp").exists()):
        parser.error("process state must be a fresh runner-owned path")
    if args.with_openrouter and not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("--with-openrouter requires OPENROUTER_API_KEY")
    if args.scale_pages is not None and not 251 <= args.scale_pages <= 2_000:
        parser.error("--scale-pages must be between 251 and 2000")
    requested_vault = args.vault
    if requested_vault is None and args.scale_pages is None:
        requested_vault = root / ".demo" / "vault"
    if requested_vault is not None and requested_vault.is_symlink():
        parser.error("A demo vault must not be a symbolic link.")
    if args.scale_pages is not None:
        scale_root = root / ".demo"
        scale_root.mkdir(parents=True, exist_ok=True)
        vault = (
            args.vault.resolve()
            if args.vault
            else Path(tempfile.mkdtemp(prefix="scale-vault-", dir=scale_root)) / "vault"
        )
        result = create_scale_vault(vault, count=args.scale_pages)
        print(
            f"Scale fixture: {result['pages']} pages, {result['edges']} links, vault {vault}",
            flush=True,
        )
    else:
        vault = (args.vault or root / ".demo" / "vault").resolve()
    _require_completed_seed(vault)
    if args.scale_pages is None and not (vault / ".wiki.git").exists() and not args.empty:
        seed_vault(vault)
    if not (root / "frontend" / "node_modules").is_dir():
        raise SystemExit("Run `cd frontend && npm ci` first.")
    env = {
        **os.environ,
        "SECOND_BRAIN_WIKI_VAULT": str(vault),
        "PYTHONPATH": str(root / "backend" / "src"),
        "API_PORT": "8000",
        # A demonstration never inherits a real remote or hosted provider target.
        "SECOND_BRAIN_WIKI_GIT_SYNC": "0",
        "SECOND_BRAIN_WIKI_GRAPH_INDEX": "0",
        "SECOND_BRAIN_WIKI_VECTOR_INDEX": "0",
        "SECOND_BRAIN_WIKI_DELIVERY": "1",
    }
    if not args.with_openrouter:
        env["OPENROUTER_API_KEY"] = ""
    children: list[subprocess.Popen[bytes]] = []
    launching = False
    cleaning = False
    stop_requested = False

    def stop(signum: int, frame: object) -> None:
        nonlocal stop_requested
        if stop_requested:
            return
        stop_requested = True
        # Popen can already have created a separate session before returning.
        # Register it and publish its receipt before honoring a catchable stop.
        # Do not mask signals: that mask would be inherited by the new child.
        if not launching and not cleaning:
            raise KeyboardInterrupt

    def launch(command: Sequence[str], cwd: Path, *, complete: bool) -> None:
        nonlocal launching
        launching = True
        try:
            child = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
            children.append(child)
            _record_processes(args.process_state, children, complete=complete)
        finally:
            launching = False
        if stop_requested:
            raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    exit_code = 0
    try:
        _record_processes(args.process_state, children, complete=False)
        launch(
            [
                sys.executable,
                "-m",
                "uvicorn",
                "second_brain.wiki.api:app_factory",
                "--factory",
                "--host",
                "127.0.0.1",
                "--port",
                "8000",
            ],
            cwd=root, complete=False,
        )
        launch(
            [
                "npm",
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--strictPort",
                "--mode",
                "demo",
            ],
            cwd=root / "frontend", complete=True,
        )
        print(
            f"Managed wiki demo: http://127.0.0.1:5173 — vault {vault} — "
            "Ctrl+C stops both processes.",
            flush=True,
        )
        exit_code = _wait_for_children(children)
        print("Managed wiki demo stopped because a service exited unexpectedly.", file=sys.stderr)
    except KeyboardInterrupt:
        pass
    finally:
        cleaning = True
        try:
            _stop_children(children)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            exit_code = 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
