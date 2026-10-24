"""Explicit, non-destructive seeding of a standalone fictional wiki vault.

Run from a source checkout: python -m second_brain.wiki.demo --vault .demo/vault
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from second_brain.wiki.store import WikiError, WikiStore, split_frontmatter

MARKER = ".second-brain-demo.json"
FORMAT_VERSION = 1


class DemoSeedError(ValueError):
    """The requested seed cannot be proven safe."""


def default_template() -> Path:
    return Path(__file__).resolve().parents[4] / "examples" / "demo-vault"


def _read_template(template: Path) -> dict[str, str]:
    if not template.is_dir() or template.is_symlink():
        raise DemoSeedError(f"Template must be a real directory: {template}")
    pages: dict[str, str] = {}
    for path in sorted(template.iterdir()):
        if path.suffix != ".md":
            continue
        if not path.is_file() or path.is_symlink():
            raise DemoSeedError(f"Template pages must be regular files: {path}")
        markdown = path.read_text(encoding="utf-8")
        content, _ = split_frontmatter(markdown)
        if not content.lstrip().startswith("# ") or not markdown.strip():
            raise DemoSeedError(f"Template page needs a level-one title: {path.name}")
        pages[path.stem] = markdown
    if not pages:
        raise DemoSeedError(f"Template contains no Markdown pages: {template}")
    return pages


def _fingerprint(pages: dict[str, str]) -> str:
    payload = json.dumps(pages, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _write_marker(path: Path, marker: dict[str, Any], *, create: bool = False) -> None:
    payload = json.dumps(marker, indent=2, sort_keys=True) + "\n"
    if create:
        # Exclusive creation also prevents two fresh seeders from owning this vault.
        with path.open("x", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        return
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=".demo-marker-",
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _seed_locked(
    vault: Path,
    pages: dict[str, str],
    fingerprint: str,
    *,
    resume: bool,
) -> dict[str, Any]:
    marker_path = vault / MARKER
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DemoSeedError("Demo marker is unreadable; no pages were changed.") from exc
    if not isinstance(marker, dict) or marker.get("format") != FORMAT_VERSION:
        raise DemoSeedError("Unrecognized demo marker; no pages were changed.")
    if marker.get("fingerprint") != fingerprint:
        raise DemoSeedError("Template differs from this seed; no pages were changed.")
    state = marker.get("state")
    if state not in {"seeding", "complete"}:
        raise DemoSeedError("Unrecognized demo state; no pages were changed.")
    if state == "seeding" and not resume:
        raise DemoSeedError(
            "This seed was interrupted. Retry with --resume and the same template "
            "to verify existing pages before writing only missing pages."
        )
    repository = vault / ".wiki.git"
    if state == "complete" and (not repository.is_dir() or repository.is_symlink()):
        raise DemoSeedError("Completed demo repository is missing or unsafe.")
    store = WikiStore(vault)
    existing = store.list_pages()
    actual = {page["id"]: page["markdown"] for page in existing}
    if len(actual) != len(existing) or any(
        page_id not in pages or pages[page_id] != markdown for page_id, markdown in actual.items()
    ):
        raise DemoSeedError("Demo pages were changed or added; no pages were changed.")
    if state == "complete":
        if actual != pages:
            raise DemoSeedError("Demo pages were removed; no pages were changed.")
        return {"status": "unchanged", "pages": len(pages), "vault": str(vault)}

    # All existing pages have been verified as an exact subset. Never overwrite
    # any page: missing pages enter through the normal revisioned create path.
    for page_id, markdown in pages.items():
        if page_id in actual:
            continue
        response = store.save_page(
            page_id,
            markdown,
            base_revision=None,
            request_id=f"demo-{fingerprint}-{hashlib.sha256(page_id.encode()).hexdigest()}",
        )
        saved = store.get_page(page_id)
        if saved is None or saved["markdown"] != markdown:
            raise DemoSeedError(f"Managed save failed for {page_id}: {response!r}")
    final = {page["id"]: page["markdown"] for page in store.list_pages()}
    if final != pages:
        raise DemoSeedError("Vault changed while seeding; completion marker was not written.")
    marker["state"] = "complete"
    _write_marker(marker_path, marker)
    return {"status": "created", "pages": len(pages), "vault": str(vault)}


def seed_vault(
    vault: Path | str,
    template: Path | str | None = None,
    *,
    resume: bool = False,
) -> dict[str, Any]:
    """Seed empty storage, verify a completed seed, or explicitly resume an exact partial seed."""
    vault = Path(vault).absolute()
    pages = _read_template(Path(template) if template is not None else default_template())
    fingerprint = _fingerprint(pages)
    if vault.is_symlink():
        raise DemoSeedError("A demo vault must not be a symbolic link.")
    if vault.exists() and not vault.is_dir():
        raise DemoSeedError("A demo vault must be a directory.")
    marker_path = vault / MARKER
    fresh = not vault.exists() or not any(vault.iterdir())
    if not fresh and (not marker_path.is_file() or marker_path.is_symlink()):
        raise DemoSeedError("Refusing a nonempty vault: choose a new empty directory.")
    if fresh:
        vault.mkdir(parents=True, exist_ok=True)
        marker = {"format": FORMAT_VERSION, "state": "seeding", "fingerprint": fingerprint}
        try:
            _write_marker(marker_path, marker, create=True)
        except FileExistsError as exc:
            raise DemoSeedError(
                "Another seeder claimed this vault; no pages were written."
            ) from exc
    if not fresh:
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise DemoSeedError("Demo marker is unreadable; no content was changed.") from exc
        if not isinstance(marker, dict) or marker.get("format") != FORMAT_VERSION:
            raise DemoSeedError("Unrecognized demo marker; no content was changed.")
        if marker.get("fingerprint") != fingerprint:
            raise DemoSeedError("Template differs from this seed; no content was changed.")
        if marker.get("state") not in {"complete", "seeding"}:
            raise DemoSeedError("Unrecognized demo state; no content was changed.")
        if marker.get("state") == "complete" and not (vault / ".wiki.git").is_dir():
            raise DemoSeedError("Completed demo repository is missing; no content was changed.")
        if marker.get("state") != "complete" and not resume:
            raise DemoSeedError("Seed interrupted; use --resume to verify and finish it.")
    # Completed state is replaced atomically after all saves. A separate stable
    # lock serializes concurrent seeders and is released if a process stops.
    lock_path = vault / ".second-brain-demo.lock"
    if lock_path.is_symlink():
        raise DemoSeedError("Demo lock must not be a symbolic link.")
    with lock_path.open("a+b") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        return _seed_locked(vault, pages, fingerprint, resume=resume or fresh)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path, help="Explicit empty demo vault path")
    parser.add_argument("--template", type=Path, help="Flat directory of Markdown template pages")
    parser.add_argument(
        "--resume", action="store_true", help="Verify and finish an interrupted seed"
    )
    args = parser.parse_args(argv)
    try:
        result = seed_vault(args.vault, args.template, resume=args.resume)
    except (DemoSeedError, WikiError, OSError) as exc:
        print(f"Demo seed refused: {exc}", file=sys.stderr)
        return 1
    print(f"Demo {result['status']}: {result['pages']} fictional pages in {result['vault']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
