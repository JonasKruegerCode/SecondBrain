"""
Typed vault operations — the constrained action space of the edit_vault agent.

The planning LLM never rewrites pages as free prose. It emits a list of these
operations; everything here applies them deterministically to the Markdown
files. Unchanged content is passed through verbatim, which is the structural
defence against confabulation.
"""
from __future__ import annotations

import difflib
import logging
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from second_brain.memory.indexing import (
    inject_links_into_text,
    normalize_rel,
    read_title,
    slugify,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Operation types
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AddClaim:
    page: str
    text: str
    section: str | None = None


@dataclass(frozen=True)
class EditSection:
    page: str
    section: str
    text: str


@dataclass(frozen=True)
class CreatePage:
    title: str
    content: str


@dataclass(frozen=True)
class Link:
    page: str
    to: str
    type: str | None = None  # relation label, e.g. "uses", "part_of"


@dataclass(frozen=True)
class Merge:
    source: str
    target: str


@dataclass(frozen=True)
class MarkOutdated:
    page: str
    reason: str


Operation = AddClaim | EditSection | CreatePage | Link | Merge | MarkOutdated


def describe(op: Operation) -> str:
    """Short human-readable summary for logs and commit messages."""
    if isinstance(op, AddClaim):
        return f"add_claim → {op.page}: {op.text[:80]}"
    if isinstance(op, EditSection):
        return f"edit_section → {op.page} § {op.section}"
    if isinstance(op, CreatePage):
        return f"create_page → {op.title}"
    if isinstance(op, Link):
        rel = f" ({op.type})" if op.type else ""
        return f"link → {op.page} → {op.to}{rel}"
    if isinstance(op, Merge):
        return f"merge → {op.source} into {op.target}"
    return f"mark_outdated → {op.page}: {op.reason[:80]}"


# ---------------------------------------------------------------------------
# Parsing / validation of LLM output
# ---------------------------------------------------------------------------

def _str(raw: dict[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def parse_operations(raw_ops: Any) -> tuple[list[Operation], list[str]]:
    """Validates raw LLM JSON into typed operations.

    Returns (operations, rejected) — invalid entries are dropped with a reason
    instead of failing the whole plan.
    """
    ops: list[Operation] = []
    rejected: list[str] = []
    if not isinstance(raw_ops, list):
        return [], [f"operations is not a list: {type(raw_ops).__name__}"]

    for raw in raw_ops:
        if not isinstance(raw, dict):
            rejected.append(f"not an object: {raw!r}")
            continue
        kind = raw.get("op")
        page = _str(raw, "page")
        text = _str(raw, "text")
        parsed: Operation | None = None

        if kind == "add_claim" and page and text:
            parsed = AddClaim(page=page, text=text, section=_str(raw, "section"))
        elif kind == "edit_section" and page and text and _str(raw, "section"):
            parsed = EditSection(page=page, section=_str(raw, "section") or "", text=text)
        elif kind == "create_page" and _str(raw, "title") and _str(raw, "content"):
            parsed = CreatePage(
                title=_str(raw, "title") or "", content=_str(raw, "content") or ""
            )
        elif kind == "link" and page and _str(raw, "to"):
            rel_type = _str(raw, "type")
            parsed = Link(
                page=page,
                to=_str(raw, "to") or "",
                type=normalize_rel(rel_type) if rel_type else None,
            )
        elif kind == "merge" and _str(raw, "source") and _str(raw, "target"):
            parsed = Merge(source=_str(raw, "source") or "", target=_str(raw, "target") or "")
        elif kind == "mark_outdated" and page and _str(raw, "reason"):
            parsed = MarkOutdated(page=page, reason=_str(raw, "reason") or "")

        if parsed is None:
            rejected.append(f"invalid or incomplete op: {raw!r}")
        else:
            ops.append(parsed)
    return ops, rejected


# ---------------------------------------------------------------------------
# Markdown helpers
# ---------------------------------------------------------------------------

def _touch_last_updated(md: str, today: str) -> str:
    """Sets the `last_updated:` line — deterministic, never left to the LLM."""
    if re.search(r"(?m)^last_updated:.*$", md):
        return re.sub(r"(?m)^last_updated:.*$", f"last_updated: {today}", md, count=1)
    lines = md.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("# "):
            lines[i + 1:i + 1] = ["", f"last_updated: {today}"]
            return "\n".join(lines) + ("\n" if md.endswith("\n") else "")
    return f"last_updated: {today}\n\n{md}"


def _section_bounds(lines: list[str], section: str) -> tuple[int, int] | None:
    """Returns (start, end) line indices of a section body (heading excluded)."""
    wanted = section.strip().lstrip("#").strip().lower()
    start: int | None = None
    level = 0
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if not m:
            continue
        if start is None:
            if m.group(2).strip().lower() == wanted:
                start = i + 1
                level = len(m.group(1))
        elif len(m.group(1)) <= level:
            return (start, i)
    if start is None:
        return None
    return (start, len(lines))


def _append_section(md: str, heading: str, text: str) -> str:
    return md.rstrip() + f"\n\n## {heading.strip().lstrip('#').strip()}\n\n{text}\n"


def _strip_page_header(md: str) -> str:
    """Removes the H1 and last_updated line — used when merging a page's body."""
    lines = [
        line for line in md.splitlines()
        if not line.startswith("# ") and not line.startswith("last_updated:")
    ]
    return "\n".join(lines).strip()


def _page_diff_summary(old: str, new: str, max_lines: int = 10) -> str:
    """Returns changed lines (+/-) as a compact string."""
    lines = []
    for line in difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm=""):
        if line.startswith(("---", "+++", "@@")):
            continue
        if line.startswith(("+", "-")):
            body = line[1:].strip()
            if body and not body.startswith("last_updated"):
                lines.append(line[0] + " " + body)
    preview = lines[:max_lines]
    suffix = f"\n… ({len(lines) - max_lines} more)" if len(lines) > max_lines else ""
    return "\n".join(preview) + suffix


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------

@dataclass
class ApplyResult:
    changed: dict[str, str] = field(default_factory=dict)   # slug → diff summary
    created: set[str] = field(default_factory=set)
    merged: bool = False
    skipped: list[str] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)        # describe() lines


class _Vault:
    """Tracks before/after snapshots so ApplyResult can carry diff summaries."""

    def __init__(self, wiki_base: Path) -> None:
        self.wiki_base = wiki_base
        self._before: dict[str, str] = {}

    def path(self, slug: str) -> Path:
        return self.wiki_base / f"{slug}.md"

    def read(self, slug: str) -> str | None:
        p = self.path(slug)
        if not p.exists():
            return None
        content = p.read_text(encoding="utf-8")
        self._before.setdefault(slug, content)
        return content

    def write(self, slug: str, content: str) -> None:
        self._before.setdefault(slug, "")
        self.path(slug).write_text(content, encoding="utf-8")

    def diff(self, slug: str) -> str:
        after = self.path(slug).read_text(encoding="utf-8") if self.path(slug).exists() else ""
        return _page_diff_summary(self._before.get(slug, ""), after)


def apply_operations(ops: list[Operation], wiki_base: Path) -> ApplyResult:
    """Applies operations sequentially to the vault. Never raises per-op —
    impossible operations are recorded in `skipped`."""
    wiki_base.mkdir(parents=True, exist_ok=True)
    vault = _Vault(wiki_base)
    result = ApplyResult()
    today = date.today().isoformat()

    for op in ops:
        try:
            _apply_one(op, vault, result, today)
        except Exception as exc:
            logger.warning("Operation failed (%s): %s", describe(op), exc)
            result.skipped.append(f"{describe(op)} — error: {exc}")

    for slug in result.changed:
        result.changed[slug] = vault.diff(slug)
    return result


def _mark_changed(result: ApplyResult, op: Operation, *slugs: str) -> None:
    for slug in slugs:
        result.changed.setdefault(slug, "")
    result.applied.append(describe(op))


def _apply_one(op: Operation, vault: _Vault, result: ApplyResult, today: str) -> None:
    if isinstance(op, AddClaim):
        md = vault.read(op.page)
        if md is None:
            result.skipped.append(f"{describe(op)} — page not found")
            return
        lines = md.splitlines()
        bounds = _section_bounds(lines, op.section) if op.section else None
        if bounds:
            start, end = bounds
            body = lines[start:end]
            while body and not body[-1].strip():
                body.pop()
            lines[start:end] = [*body, "", op.text]
            md = "\n".join(lines) + "\n"
        elif op.section:
            md = _append_section(md, op.section, op.text)
        else:
            md = md.rstrip() + f"\n\n{op.text}\n"
        vault.write(op.page, _touch_last_updated(md, today))
        _mark_changed(result, op, op.page)

    elif isinstance(op, EditSection):
        md = vault.read(op.page)
        if md is None:
            result.skipped.append(f"{describe(op)} — page not found")
            return
        lines = md.splitlines()
        bounds = _section_bounds(lines, op.section)
        if bounds:
            start, end = bounds
            lines[start:end] = ["", *op.text.splitlines(), ""]
            md = "\n".join(lines) + "\n"
        else:
            md = _append_section(md, op.section, op.text)
        vault.write(op.page, _touch_last_updated(md, today))
        _mark_changed(result, op, op.page)

    elif isinstance(op, CreatePage):
        slug = slugify(op.title)
        if not slug:
            result.skipped.append(f"{describe(op)} — empty slug")
            return
        if vault.path(slug).exists():
            result.skipped.append(f"{describe(op)} — page already exists, use edit ops")
            return
        content = op.content
        if not content.lstrip().startswith("# "):
            content = f"# {op.title}\n\n{content}"
        vault.write(slug, _touch_last_updated(content.rstrip() + "\n", today))
        result.created.add(slug)
        _mark_changed(result, op, slug)

    elif isinstance(op, Link):
        md = vault.read(op.page)
        if md is None:
            result.skipped.append(f"{describe(op)} — page not found")
            return
        target_path = vault.path(op.to)
        if not target_path.exists():
            result.skipped.append(f"{describe(op)} — target not found")
            return
        if op.type:
            # Typed relation → Dataview-style line under ## Relations;
            # derived into a `rel`-attributed Neo4j edge by indexing.parse_links.
            line = f"- {op.type}:: [[{op.to}]]"
            if re.search(
                rf"(?m)^\s*(?:[-*]\s+)?{re.escape(op.type)}::\s*\[\[{re.escape(op.to)}[\]|]",
                md,
                re.IGNORECASE,
            ):
                result.skipped.append(f"{describe(op)} — already linked")
                return
            lines = md.splitlines()
            bounds = _section_bounds(lines, "Relations")
            if bounds:
                start, end = bounds
                body = lines[start:end]
                while body and not body[-1].strip():
                    body.pop()
                lines[start:end] = [*body, line]
                new_md = "\n".join(lines) + "\n"
            else:
                new_md = _append_section(md, "Relations", line)
            vault.write(op.page, new_md)
            _mark_changed(result, op, op.page)
            return
        if re.search(rf"\[\[{re.escape(op.to)}[\]|]", md, re.IGNORECASE):
            result.skipped.append(f"{describe(op)} — already linked")
            return
        title = read_title(target_path)
        new_md = inject_links_into_text(md, op.page, {op.to: title})
        if new_md == md:
            new_md = md.rstrip() + f"\n\nRelated: [[{op.to}]]\n"
        vault.write(op.page, new_md)
        _mark_changed(result, op, op.page)

    elif isinstance(op, Merge):
        _apply_merge(op, vault, result, today)

    elif isinstance(op, MarkOutdated):
        md = vault.read(op.page)
        if md is None:
            result.skipped.append(f"{describe(op)} — page not found")
            return
        marker = f"> **Outdated:** {op.reason}"
        if marker in md:
            result.skipped.append(f"{describe(op)} — already marked")
            return
        lines = md.splitlines()
        for i, line in enumerate(lines):
            if line.startswith("# "):
                lines[i + 1:i + 1] = ["", marker]
                break
        else:
            lines[0:0] = [marker, ""]
        vault.write(op.page, _touch_last_updated("\n".join(lines) + "\n", today))
        _mark_changed(result, op, op.page)


def _apply_merge(op: Merge, vault: _Vault, result: ApplyResult, today: str) -> None:
    """Lossless mechanical merge: the source body is appended verbatim to the
    target, all backlinks are rewired, and the source becomes a redirect stub.
    No LLM is involved — a later repair run may tidy the merged section."""
    if op.source == op.target:
        result.skipped.append(f"{describe(op)} — source equals target")
        return
    source_md = vault.read(op.source)
    target_md = vault.read(op.target)
    if source_md is None or target_md is None:
        result.skipped.append(f"{describe(op)} — source or target not found")
        return

    source_title = read_title(vault.path(op.source))
    body = _strip_page_header(source_md)
    if body:
        target_md = target_md.rstrip() + f"\n\n## Merged from: {source_title}\n\n{body}\n"
    vault.write(op.target, _touch_last_updated(target_md, today))

    # Rewire backlinks: [[source]] / [[source|Display]] → target
    pattern = re.compile(rf"\[\[{re.escape(op.source)}(\|[^\]]*)?\]\]", re.IGNORECASE)
    rewired: list[str] = []
    for f in vault.wiki_base.rglob("*.md"):
        if f.stem in (op.source, op.target):
            continue
        content = vault.read(f.stem) or ""
        new_content = pattern.sub(lambda m: f"[[{op.target}{m.group(1) or ''}]]", content)
        if new_content != content:
            vault.write(f.stem, new_content)
            rewired.append(f.stem)

    # Redirect stub so old IDs keep resolving
    stub = (
        f"# {source_title}\n\n"
        f"last_updated: {today}\n\n"
        f"This page was merged into [[{op.target}]].\n"
    )
    vault.write(op.source, stub)

    result.merged = True
    _mark_changed(result, op, op.target, op.source, *rewired)
