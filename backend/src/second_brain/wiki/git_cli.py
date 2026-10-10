"""Explicit inspect, publish and import commands for a caller-selected Git wiki."""

from __future__ import annotations

import argparse
import json
import sys

from second_brain.wiki.remote import ManagedGitSync
from second_brain.wiki.store import WikiError, WikiStore


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--remote", required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--prefix", default="")
    commands = parser.add_subparsers(dest="operation", required=True)
    commands.add_parser("inspect", help="Observe the remote pointer once; no content mutation")
    push = commands.add_parser("push", help="Publish reviewed local Markdown with normal Git push")
    push.add_argument("--base-revision", required=True)
    guard = push.add_mutually_exclusive_group(required=True)
    guard.add_argument("--remote-empty", action="store_true")
    guard.add_argument("--expected-remote-revision")
    push.add_argument("--request-id", required=True)
    pull = commands.add_parser("pull", help="Deliberately import a reviewed remote snapshot")
    guard = pull.add_mutually_exclusive_group(required=True)
    guard.add_argument("--managed-empty", action="store_true")
    guard.add_argument("--base-revision")
    pull.add_argument("--expected-remote-revision", required=True)
    pull.add_argument("--request-id", required=True)
    args = parser.parse_args(argv)
    try:
        sync = ManagedGitSync(WikiStore(args.vault), args.remote, args.branch, args.prefix)
        if args.operation == "inspect":
            result = sync.inspect()
        elif args.operation == "push":
            result = sync.push(args.base_revision, args.expected_remote_revision, args.request_id)
        else:
            result = sync.pull(args.base_revision, args.expected_remote_revision, args.request_id)
    except WikiError as exc:
        print(json.dumps({"error": exc.code, "message": exc.message}), file=sys.stderr)
        return 1
    except OSError:
        print(
            json.dumps(
                {"error": "storage_unavailable", "message": "Local sync storage is unavailable."}
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
