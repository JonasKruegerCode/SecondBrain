"""Verify one managed import against its clean local Git source.

The audit is read-only. It pins both sides to immutable commits and proves that
page IDs, Markdown bytes, source-path provenance and the retained source parent
all match the reviewed import.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath
from typing import Any

from second_brain.wiki.importer import _source_snapshot
from second_brain.wiki.store import WikiError, WikiStore

COMMIT_RE = re.compile(r"[0-9a-f]{40}\Z")


def _digest(pages: dict[str, bytes]) -> str:
    digest = hashlib.sha256()
    for page_id, data in sorted(pages.items()):
        encoded_id = page_id.encode()
        digest.update(len(encoded_id).to_bytes(4, "big"))
        digest.update(encoded_id)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def _managed_pages(store: WikiStore, revision: str) -> dict[str, bytes]:
    blobs = store._snapshot_blobs(revision, "pages/")
    return {
        PurePosixPath(path).stem: data
        for path, data in blobs.items()
        if path.startswith("pages/") and path.endswith(".md")
    }


def _matching_provenance(
    store: WikiStore,
    revision: str,
    source_revision: str,
    paths: dict[str, str],
) -> bool:
    for data in store._snapshot_blobs(revision, "imports/").values():
        try:
            provenance = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if provenance == {"source_revision": source_revision, "paths": paths}:
            return True
    return False


def audit_import(
    store: WikiStore,
    source: Path | str,
    *,
    revision: str,
    prefix: str = "",
) -> dict[str, Any]:
    """Prove that one reachable managed revision is the exact reviewed import."""
    if not COMMIT_RE.fullmatch(revision):
        raise WikiError("invalid_audit", "Provide the full imported managed revision.")
    head = store._head()
    reachable = store._git("rev-list", "--first-parent", head, check=False).decode().splitlines()
    if revision not in reachable:
        raise WikiError(
            "revision_not_reachable",
            "The imported revision is not in the current managed snapshot history.",
        )

    source_revision, source_pages, source_paths = _source_snapshot(Path(source).absolute(), prefix)
    if not source_revision:
        raise WikiError("empty_audit", "An unborn source has no committed migration to verify.")

    managed_pages = _managed_pages(store, revision)
    missing = sorted(set(source_pages) - set(managed_pages))
    unexpected = sorted(set(managed_pages) - set(source_pages))
    changed = sorted(
        page_id
        for page_id in set(source_pages) & set(managed_pages)
        if source_pages[page_id] != managed_pages[page_id]
    )
    if missing or unexpected or changed:
        raise WikiError(
            "content_mismatch",
            "The managed revision is not an exact page snapshot of the source commit.",
            missing=missing,
            unexpected=unexpected,
            changed=changed,
        )

    parents = store._git("show", "-s", "--format=%P", revision).decode().split()
    if source_revision not in parents:
        raise WikiError(
            "history_mismatch",
            "The managed revision does not retain the reviewed source commit as a parent.",
        )
    if not _matching_provenance(store, revision, source_revision, source_paths):
        raise WikiError(
            "provenance_mismatch",
            "The managed revision does not retain the reviewed source-path mapping.",
        )
    # This also rejects a destination whose retained parent is missing ancestors
    # or objects. Import itself performs the same check on the source repository.
    store._git("fsck", "--full", "--no-reflogs")

    return {
        "operation": "import_audit",
        "status": "verified",
        "managed_revision": revision,
        "current_revision": head,
        "source_revision": source_revision,
        "pages": len(source_pages),
        "content_sha256": _digest(source_pages),
        "page_ids": sorted(source_pages),
        "markdown_bytes": "exact",
        "source_paths": "verified",
        "source_history": "retained",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--prefix", default="")
    args = parser.parse_args(argv)
    try:
        vault = args.vault.absolute()
        if not (vault / ".wiki.git").is_dir():
            raise WikiError("invalid_vault", "Choose an existing managed wiki directory.")
        result = audit_import(
            WikiStore(vault),
            args.source,
            revision=args.revision,
            prefix=args.prefix,
        )
    except (WikiError, OSError) as exc:
        code = exc.code if isinstance(exc, WikiError) else "storage_unavailable"
        message = exc.message if isinstance(exc, WikiError) else "Migration storage is unavailable."
        details = exc.details if isinstance(exc, WikiError) else {}
        print(json.dumps({"error": code, "message": message, **details}), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
