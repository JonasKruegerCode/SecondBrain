"""Explicit, revision-guarded import of a clean local Git wiki.

The source is never checked out, pulled, changed or configured by this module.
One managed ref transition publishes the whole committed Markdown snapshot.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

from second_brain.wiki.store import MAX_BYTES, REF, WikiError, WikiStore


def _source_git(source: Path, *args: str, check: bool = True) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(source), *args],
        capture_output=True,
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_LITERAL_PATHSPECS": "1",
        },
        check=False,
    )
    if check and result.returncode:
        raise WikiError("invalid_import", "Unable to read the local source repository.")
    return result.stdout


def _source_snapshot(source: Path, prefix: str) -> tuple[str, dict[str, bytes], dict[str, str]]:
    if not source.is_dir() or source.is_symlink() or not (source / ".git").exists():
        raise WikiError("invalid_import", "Choose a local Git working repository.")
    root = _source_git(source, "rev-parse", "--show-toplevel").decode().strip()
    if Path(root).resolve() != source.resolve():
        raise WikiError("invalid_import", "The source must be the repository root.")
    if (
        _source_git(source, "rev-parse", "--is-shallow-repository").strip() == b"true"
        or _source_git(source, "config", "--get", "extensions.partialClone", check=False)
        or _source_git(source, "config", "--get-regexp", r"remote\..*\.promisor", check=False)
    ):
        raise WikiError("incomplete_source", "Use a complete local clone with all history objects.")
    if _source_git(source, "status", "--porcelain=v1", "-z", "--untracked-files=all"):
        raise WikiError("dirty_source", "Commit or preserve source edits before importing.")
    if prefix:
        path = PurePosixPath(prefix)
        if path.is_absolute() or ".." in path.parts or "\\" in prefix or path == PurePosixPath("."):
            raise WikiError("invalid_import", "The page prefix must be relative to the repository.")
        prefix = path.as_posix().rstrip("/") + "/"
    head = _source_git(source, "rev-parse", "--verify", "HEAD", check=False).decode().strip()
    if not head:
        if prefix:
            raise WikiError("invalid_import", "The requested prefix does not exist in the source.")
        return "", {}, {}
    if prefix and not _source_git(source, "ls-tree", "-d", head, "--", prefix.rstrip("/")):
        raise WikiError("invalid_import", "The requested prefix does not exist in the source.")
    # A retained source parent must never introduce missing ancestors/objects.
    _source_git(source, "fsck", "--full", "--no-reflogs")
    rows = _source_git(source, "ls-tree", "-r", "-z", "--full-tree", head, "--", prefix or ".")
    pages: dict[str, bytes] = {}
    paths: dict[str, str] = {}
    for row in rows.split(b"\0"):
        if not row:
            continue
        metadata, raw_path = row.split(b"\t", 1)
        try:
            name = raw_path.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WikiError("invalid_import", "Source paths must be UTF-8.") from exc
        if not name.endswith(".md"):
            continue
        mode, kind, sha = metadata.decode().split()
        if mode not in {"100644", "100755"} or kind != "blob":
            raise WikiError("invalid_import", "Markdown pages must be regular Git blobs.")
        page_id = PurePosixPath(name).stem
        WikiStore._validate_id(page_id)
        if page_id in pages:
            raise WikiError("ambiguous_import", "Two source paths have the same page ID.")
        size = int(_source_git(source, "cat-file", "-s", sha))
        if size > MAX_BYTES:
            raise WikiError("content_too_large", "Pages are limited to one megabyte.")
        data = _source_git(source, "cat-file", "blob", sha)
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise WikiError("invalid_import", "Markdown pages must be UTF-8.") from exc
        pages[page_id], paths[page_id] = data, name
    return head, pages, paths


def import_vault(
    store: WikiStore,
    source: Path | str,
    *,
    prefix: str = "",
    base_revision: str | None,
    request_id: str,
) -> dict[str, Any]:
    """Replace the full managed page set, with an explicit expected snapshot head.

    None is create-only on a never-published managed store. A later import must
    name the whole store's current Git revision, not one page's revision token.
    The source history is retained as a second parent, with path provenance.
    """
    source = Path(source).absolute()
    resolved = source.resolve()
    if resolved.is_relative_to(store.path) or store.path.is_relative_to(resolved):
        raise WikiError("invalid_import", "Source and managed destination must be separate.")
    if not request_id.strip() or len(request_id) > 200:
        raise WikiError("invalid_request_id", "Provide a stable request ID up to 200 characters.")
    source_head, pages, paths = _source_snapshot(source, prefix)
    fingerprint = hashlib.sha256(
        json.dumps(
            [source_head, PurePosixPath(prefix).as_posix(), paths, base_revision], sort_keys=True
        ).encode()
    ).hexdigest()
    request_path = f"requests/{hashlib.sha256(request_id.encode()).hexdigest()}.json"
    head = store._head()
    recorded = store._blob(head, request_path)
    if recorded:
        receipt = json.loads(recorded)
        if receipt["fingerprint"] != fingerprint:
            raise WikiError("request_id_reused", "This request ID has a different payload.")
        return _published_result(store, request_path, fingerprint)
    if (head or None) != base_revision:
        raise WikiError(
            "revision_conflict",
            "The wiki changed. Review its snapshot before importing.",
            current_revision=head or None,
        )
    if not pages and store._pages(head):
        raise WikiError("empty_import", "An empty import cannot replace a populated wiki.")
    # Transfer source objects only; do not copy remotes, credentials, hooks or config.
    # The retained parent makes original commits reachable through normal backups.
    if source_head:
        store._git(
            "-c",
            "protocol.file.allow=always",
            "fetch",
            "--no-tags",
            "--no-write-fetch-head",
            str(resolved),
            source_head,
            env={"GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1"},
        )
    provenance = {"source_revision": source_head or None, "paths": paths}
    result: dict[str, Any] = {
        "publication": "imported",
        "pages": len(pages),
        "source_revision": source_head or None,
        "index": {"graph": "pending", "vector": "pending"},
        "remote_sync": "not_configured",
        "request_id": request_id,
    }
    # The commit hash cannot be inside its own tree. A receipt binds to its
    # immutable publication commit via the request file's first-parent history.
    receipt_data = json.dumps({"fingerprint": fingerprint, "result": result}).encode()
    with tempfile.TemporaryDirectory(prefix="wiki-import-") as tmp:
        env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
        store._git("read-tree", head if head else "--empty", env=env)
        old_paths = store._git("ls-files", "-z", "--", "pages/", "revisions/", env=env)
        if old_paths:
            deletions = b"".join(
                b"0 " + b"0" * 40 + b"\t" + p + b"\0" for p in old_paths.split(b"\0") if p
            )
            store._git("update-index", "-z", "--index-info", data=deletions, env=env)
        additions: dict[str, bytes] = {
            request_path: receipt_data,
            f"imports/{fingerprint}.json": json.dumps(provenance).encode(),
        }
        for page_id, data in pages.items():
            additions[f"pages/{page_id}.md"] = data
            additions[f"revisions/{page_id}"] = (
                hashlib.sha256((head + fingerprint + request_id + page_id).encode())
                .hexdigest()
                .encode()
            )
        for path, data in additions.items():
            sha = store._git("hash-object", "-w", "--stdin", data=data).decode().strip()
            store._git("update-index", "--add", "--cacheinfo", "100644", sha, path, env=env)
        tree = store._git("write-tree", env=env).decode().strip()
        parents = (["-p", head] if head else []) + (["-p", source_head] if source_head else [])
        new_head = (
            store._git(
                "commit-tree", tree, *parents, data=b"wiki: imported committed Markdown snapshot\n"
            )
            .decode()
            .strip()
        )
        store._git("update-ref", REF, new_head, head or "0" * 40, check=False)
    return _published_result(store, request_path, fingerprint)


def _published_result(store: WikiStore, request_path: str, fingerprint: str) -> dict[str, Any]:
    head = store._head()
    recorded = store._blob(head, request_path)
    if recorded and json.loads(recorded)["fingerprint"] == fingerprint:
        result = dict(json.loads(recorded)["result"])
        result["revision"] = (
            store._git("log", "-1", "--first-parent", "--format=%H", head, "--", request_path)
            .decode()
            .strip()
        )
        return result
    raise WikiError(
        "revision_conflict",
        "The wiki changed during import; no import was published.",
        current_revision=head or None,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--prefix", default="")
    guard = parser.add_mutually_exclusive_group(required=True)
    guard.add_argument("--empty", action="store_true", help="Import into never-published storage")
    guard.add_argument("--base-revision", help="Expected managed snapshot Git commit")
    parser.add_argument("--request-id", required=True, help="Reuse exactly when retrying")
    args = parser.parse_args(argv)
    try:
        result = import_vault(
            WikiStore(args.vault),
            args.source,
            prefix=args.prefix,
            base_revision=args.base_revision,
            request_id=args.request_id,
        )
    except (WikiError, OSError) as exc:
        print(f"Import refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
