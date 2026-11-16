"""Create a disposable large synthetic vault through the real import path.

This fixture is deliberately separate from the polished twelve-page demo. It is
for repeatable scale and browser checks and refuses every non-empty destination.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from second_brain.wiki.importer import import_vault
from second_brain.wiki.store import WikiError, WikiStore

MIN_PAGES = 251
MAX_PAGES = 2_000
DEFAULT_GROUPS = 8


class ScaleFixtureError(ValueError):
    """The requested synthetic fixture cannot be created safely."""


def synthetic_pages(count: int, groups: int = DEFAULT_GROUPS) -> dict[str, str]:
    """Return deterministic linked pages with explicit curated constellations."""
    if not MIN_PAGES <= count <= MAX_PAGES:
        raise ScaleFixtureError(f"Choose between {MIN_PAGES} and {MAX_PAGES} pages.")
    if not 2 <= groups <= min(24, count):
        raise ScaleFixtureError("Choose between 2 and 24 constellations.")

    memberships = [
        [index for index in range(count) if index % groups == group] for group in range(groups)
    ]
    anchors = [members[0] for members in memberships]
    pages: dict[str, str] = {}
    for group, members in enumerate(memberships):
        label = f"Synthetic constellation {group + 1}"
        for position, index in enumerate(members):
            page_id = f"scale-{index:04d}"
            previous_id = f"scale-{members[position - 1]:04d}"
            next_id = f"scale-{members[(position + 1) % len(members)]:04d}"
            links = [f"Previous:: [[{previous_id}]]", f"Next:: [[{next_id}]]"]
            if position == 0:
                bridge = f"scale-{anchors[(group + 1) % groups]:04d}"
                links.append(f"Bridge:: [[{bridge}]]")
            long_tail = " with a deliberately extended navigation title" if index % 53 == 0 else ""
            pages[page_id] = (
                "---\n"
                f"galaxy_group: synthetic-{group + 1}\n"
                f"galaxy_label: {label}\n"
                f"galaxy_anchor: {'true' if position == 0 else 'false'}\n"
                "---\n"
                f"# Synthetic observation {index + 1}{long_tail}\n\n"
                "This page is generated test data for the large-vault acceptance path. "
                "It does not describe a real person, project, or event.\n\n"
                "## Recorded links\n\n- " + "\n- ".join(links) + "\n"
            )
    return pages


def _git(repo: Path, *args: str) -> None:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=False)
    if result.returncode:
        raise ScaleFixtureError("Unable to create the temporary synthetic source repository.")


def create_scale_vault(
    vault: Path | str, *, count: int = 320, groups: int = DEFAULT_GROUPS
) -> dict[str, Any]:
    """Import one generated Git snapshot into a new managed vault."""
    vault = Path(vault).absolute()
    if vault.is_symlink() or (vault.exists() and (not vault.is_dir() or any(vault.iterdir()))):
        raise ScaleFixtureError("Scale destination must be a new or empty real directory.")
    vault.parent.mkdir(parents=True, exist_ok=True)
    pages = synthetic_pages(count, groups)

    with tempfile.TemporaryDirectory(prefix="second-brain-scale-source-") as temporary:
        source = Path(temporary)
        _git(source, "init", "--quiet")
        _git(source, "config", "user.name", "Synthetic Scale Fixture")
        _git(source, "config", "user.email", "scale@example.invalid")
        for page_id, markdown in pages.items():
            (source / f"{page_id}.md").write_text(markdown, encoding="utf-8")
        _git(source, "add", "--all")
        _git(source, "commit", "--quiet", "-m", "Synthetic large-vault snapshot")
        store = WikiStore(vault)
        result = import_vault(
            store,
            source,
            base_revision=None,
            request_id=f"synthetic-scale-{count}-{groups}",
        )

    started = time.perf_counter()
    graph = store.graph()
    graph_seconds = time.perf_counter() - started
    if len(graph["nodes"]) != count or graph["missing_targets"] or graph["ambiguous_targets"]:
        raise ScaleFixtureError("Generated graph did not round-trip through the managed store.")
    return {
        **result,
        "groups": groups,
        "edges": len(graph["edges"]),
        "graph_seconds": round(graph_seconds, 6),
        "vault": str(vault),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=Path)
    parser.add_argument("--pages", type=int, default=320)
    parser.add_argument("--groups", type=int, default=DEFAULT_GROUPS)
    args = parser.parse_args(argv)
    try:
        result = create_scale_vault(args.vault, count=args.pages, groups=args.groups)
    except (ScaleFixtureError, WikiError, OSError) as exc:
        print(f"Scale fixture refused: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
