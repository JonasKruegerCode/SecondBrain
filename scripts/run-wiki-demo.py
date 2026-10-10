"""Start an isolated real-content demo; no remote Git or LLM is required."""

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from second_brain.wiki.demo import seed_vault


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, default=root / ".demo" / "vault")
    parser.add_argument(
        "--empty", action="store_true", help="Start without the fictional template"
    )
    parser.add_argument(
        "--with-openrouter",
        action="store_true",
        help="Allow the chat to use the explicitly configured OPENROUTER_API_KEY",
    )
    args = parser.parse_args()
    if args.with_openrouter and not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("--with-openrouter requires OPENROUTER_API_KEY")
    vault = args.vault.resolve()
    if not (vault / ".wiki.git").exists() and not args.empty:
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
        print("Managed wiki demo: http://127.0.0.1:5173 — Ctrl+C stops both processes.")
        while all(child.poll() is None for child in children):
            time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        for index, child in enumerate(children):
            if index == 1:
                os.killpg(child.pid, signal.SIGTERM)
            else:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == "__main__":
    main()
