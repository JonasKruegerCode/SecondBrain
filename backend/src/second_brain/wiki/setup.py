"""Choose an explicit first-start profile without silently seeding existing data."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from second_brain.wiki.demo import DemoSeedError, seed_vault
from second_brain.wiki.importer import import_vault
from second_brain.wiki.store import WikiError, WikiStore


def setup_vault(
    vault: Path | str,
    mode: str,
    *,
    source: Path | str | None = None,
    prefix: str = "",
    template: Path | str | None = None,
    resume: bool = False,
    request_id: str = "first-start-import",
) -> dict[str, Any]:
    """Create an empty core, explicit synthetic template, or create-only Git import.

    A populated wiki is never replaced by this first-start command. The separate
    importer provides deliberate later replacement with a reviewed base revision.
    """
    if mode not in {"empty", "template", "import"}:
        raise WikiError("invalid_setup", "Choose empty, template or import.")
    if mode != "import" and (source is not None or prefix):
        raise WikiError("invalid_setup", "Source and prefix apply only to Git import.")
    if mode != "template" and (template is not None or resume):
        raise WikiError("invalid_setup", "Template and resume apply only to template setup.")
    path = Path(vault).absolute()
    if path.is_symlink():
        raise WikiError("invalid_setup", "Choose a real managed vault directory.")
    if mode == "template":
        result = seed_vault(path, template, resume=resume)
        store = WikiStore(path)
    else:
        if mode == "import" and source is None:
            raise WikiError("invalid_setup", "Choose an explicit clean local Git source.")
        store = WikiStore(path)
        if mode == "empty":
            if store.list_pages():
                raise WikiError("setup_not_empty", "This wiki already contains pages.")
            result = {"status": "ready", "pages": 0}
        else:
            assert source is not None
            # import_vault resolves an identical first-start retry before checking
            # its original create-only base. A different source is not overwritten.
            result = import_vault(
                store, source, prefix=prefix, base_revision=None, request_id=request_id
            )
    return {
        **result,
        "mode": mode,
        "revision": result.get("revision", store._head() or None),
        "current_revision": store._head() or None,
        "vault": str(path),
        "next": "Start the managed API with SECOND_BRAIN_WIKI_VAULT set to this directory.",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--mode", choices=("empty", "template", "import"), required=True)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--prefix", default="")
    parser.add_argument("--template", type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--request-id", default="first-start-import")
    args = parser.parse_args(argv)
    try:
        result = setup_vault(
            args.vault,
            args.mode,
            source=args.source,
            prefix=args.prefix,
            template=args.template,
            resume=args.resume,
            request_id=args.request_id,
        )
    except (WikiError, DemoSeedError, OSError) as exc:
        print(f"Setup refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
