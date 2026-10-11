"""Start an isolated real-content demo; no remote Git or LLM is required."""

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time
from collections.abc import Sequence
from pathlib import Path

from second_brain.wiki.demo import seed_vault
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


def _stop_children(children: Sequence[subprocess.Popen[bytes]]) -> None:
    for index, child in enumerate(children):
        if child.poll() is not None:
            continue
        try:
            if index == 1:
                os.killpg(child.pid, signal.SIGTERM)
            else:
                child.terminate()
        except ProcessLookupError:
            pass
    for child in children:
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()


def main(argv: Sequence[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path)
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
    if args.with_openrouter and not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("--with-openrouter requires OPENROUTER_API_KEY")
    if args.scale_pages is not None and not 251 <= args.scale_pages <= 2_000:
        parser.error("--scale-pages must be between 251 and 2000")
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

    def stop(signum: int, frame: object) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    exit_code = 0
    try:
        children.append(
            subprocess.Popen(
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
                cwd=root,
                env=env,
            )
        )
        children.append(
            subprocess.Popen(
                [
                    "npm",
                    "run",
                    "dev",
                    "--",
                    "--host",
                    "127.0.0.1",
                    "--strictPort",
                ],
                cwd=root / "frontend",
                env=env,
                start_new_session=True,
            )
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
        _stop_children(children)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
