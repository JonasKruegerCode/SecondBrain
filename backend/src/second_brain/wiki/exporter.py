"""Publish one captured wiki revision as a plain, portable Markdown directory."""

from __future__ import annotations

import argparse
import ctypes
import errno
import json
import os
import shutil
import sys
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Any

from second_brain.wiki.store import ID_RE, WikiError, WikiStore


def _error(code: str, message: str) -> WikiError:
    return WikiError(code, message)


def _publish(prepared: Path, destination: Path) -> None:
    """Use Linux's atomic no-replace rename; fail closed on unsupported hosts."""
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        rename = libc.renameat2
    except AttributeError as exc:
        error = _error("export_unavailable", "Atomic no-replace rename is unavailable.")
        raise error from exc
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(prepared), -100, os.fsencode(destination), 1):
        code = ctypes.get_errno()
        if code in {errno.EEXIST, errno.ENOTEMPTY, errno.ELOOP}:
            error = _error("invalid_destination", "The destination changed during export.")
            raise error
        raise OSError(code, os.strerror(code), str(destination))


def _destination(path: Path, vault: Path) -> Path:
    absolute = Path(os.path.abspath(path))  # noqa: PTH100 - resolve would hide symlinks.
    for component in (absolute, *absolute.parents):
        if component.is_symlink():
            error = _error("invalid_destination", "Destination paths must not contain symlinks.")
            raise error
    if absolute == vault or absolute.is_relative_to(vault) or vault.is_relative_to(absolute):
        error = _error("invalid_destination", "The export must not overlap the managed vault.")
        raise error
    if not absolute.parent.is_dir():
        error = _error("invalid_destination", "The destination parent directory must exist.")
        raise error
    if absolute.exists() and (not absolute.is_dir() or any(absolute.iterdir())):
        error = _error("invalid_destination", "Choose a new or empty destination directory.")
        raise error
    return absolute


def export_vault(
    store: WikiStore,
    destination: Path | str,
    *,
    base_revision: str,
) -> dict[str, Any]:
    """Export exactly one snapshot; base_revision is the expected whole-vault head.

    Empty repositories use an explicit empty string. Existing nonempty outputs
    are always refused, including byte-identical previous exports.
    """
    snapshot = store.snapshot()
    revision = snapshot["revision"]
    if base_revision != (revision or ""):
        error = _error("revision_conflict", "The vault changed before export.")
        error.details["current_revision"] = revision
        raise error
    target = _destination(Path(destination), store.path)
    prepared = Path(tempfile.mkdtemp(prefix=f".{target.name}-export-", dir=target.parent))
    removed_empty = False
    try:
        names: set[str] = set()
        for page in snapshot["pages"]:
            page_id = page["id"]
            if not ID_RE.fullmatch(page_id) or page_id in {".", ".."}:
                error = _error("invalid_vault", "The snapshot contains an unsafe page ID.")
                raise error
            filename = f"{page_id}.md"
            if filename in names:
                error = _error("invalid_vault", "The snapshot contains duplicate page IDs.")
                raise error
            names.add(filename)
            (prepared / filename).write_bytes(page["markdown"].encode("utf-8"))
        # Revalidate after preparation. rmdir refuses a directory filled by a
        # concurrent writer; the final no-replace rename refuses any new target.
        _destination(target, store.path)
        if target.exists():
            target.rmdir()
            removed_empty = True
        _publish(prepared, target)
        return {
            "publication": "exported",
            "revision": revision,
            "destination": str(target),
            "page_count": len(names),
        }
    finally:
        if prepared.exists():
            shutil.rmtree(prepared)
        if removed_empty and not target.exists() and not target.is_symlink():
            with suppress(FileExistsError):
                target.mkdir()


def main() -> None:
    """Run the explicit local export command."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--base-revision", required=True)
    args = parser.parse_args()
    try:
        result = export_vault(
            WikiStore(args.vault),
            args.destination,
            base_revision=args.base_revision,
        )
    except (WikiError, OSError) as exc:
        parser.exit(1, f"Export failed: {exc}\n")
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
