"""Markdown snapshots with one Git ref as the publication boundary.

This opt-in profile uses an isolated local bare repository. It deliberately does
not turn a legacy working tree into a second writer. Remote sync and external
indices are not yet attached; reads and mutations require only local Git.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any

REF = "refs/heads/wiki"
ID_RE = re.compile(r"[\w][\w.-]{0,159}\Z", re.UNICODE)
LINK_RE = re.compile(r"\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]")
TYPED_LINK_RE = re.compile(
    r"(?m)^\s*(?:[-*]\s+)?([A-Za-z][\w -]*?)::\s*"
    r"\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]"
)
MAX_BYTES = 1_000_000


def prose_links(markdown: str) -> str:
    """Ignore code examples and comments when deriving explicit prose links."""
    lines = []
    fence = ""
    for line in markdown.splitlines():
        match = re.match(r"^ {0,3}(`{3,}|~{3,})", line)
        if match:
            marker = match.group(1)
            if not fence:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = ""
            continue
        if not fence and not line.startswith(("    ", "\t")):
            lines.append(line)
    text = re.sub(r"<!--.*?-->", "", "\n".join(lines), flags=re.DOTALL)
    return re.sub(r"(`+).*?\1", "", text, flags=re.DOTALL)


class WikiError(Exception):
    def __init__(self, code: str, message: str, **details: Any) -> None:
        self.code = code
        self.message = message
        self.details = details
        super().__init__(message)


class WikiStore:
    """A single-ref content store; separate processes use Git's compare-and-swap."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path).resolve()
        self.path.mkdir(parents=True, exist_ok=True)
        self.repo = self.path / ".wiki.git"
        if self.repo.is_symlink():
            raise WikiError("invalid_vault", "The managed repository must not be a symlink.")
        if not self.repo.exists():
            # Existing Markdown must be explicitly imported, never silently ignored.
            if any(self.path.rglob("*.md")):
                raise WikiError(
                    "import_required", "Existing Markdown requires a controlled import."
                )
            result = subprocess.run(
                ["git", "init", "--bare", "--initial-branch=wiki", str(self.repo)],
                capture_output=True,
                check=False,
            )
            if result.returncode:
                raise WikiError("storage_unavailable", "Unable to initialize local history.")

    def _git(
        self,
        *args: str,
        data: bytes | None = None,
        env: dict[str, str] | None = None,
        check: bool = True,
    ) -> bytes:
        process_env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "Managed Wiki",
            "GIT_AUTHOR_EMAIL": "wiki@localhost",
            "GIT_COMMITTER_NAME": "Managed Wiki",
            "GIT_COMMITTER_EMAIL": "wiki@localhost",
            "GIT_LITERAL_PATHSPECS": "1",
            **(env or {}),
        }
        result = subprocess.run(
            ["git", "--git-dir", str(self.repo), *args],
            input=data,
            capture_output=True,
            env=process_env,
            check=False,
        )
        if check and result.returncode:
            raise WikiError("storage_unavailable", "Local Git operation failed.")
        return result.stdout

    def _head(self) -> str:
        return self._git("rev-parse", "--verify", REF, check=False).decode().strip()

    @staticmethod
    def _validate_id(page_id: str) -> None:
        if not ID_RE.fullmatch(page_id) or page_id in {".", ".."}:
            raise WikiError("invalid_id", "Use a stable page ID without slashes or whitespace.")

    def _blob(self, head: str, path: str) -> bytes | None:
        if not head:
            return None
        if not self._git("ls-tree", head, "--", path):
            return None
        return self._git("show", f"{head}:{path}")

    @staticmethod
    def _page(page_id: str, data: bytes, revision: str) -> dict[str, Any]:
        markdown = data.decode("utf-8")
        heading = re.search(r"^#\s+(.+)$", markdown, re.MULTILINE)
        title = heading.group(1).strip() if heading else page_id
        prose = "\n".join(line for line in markdown.splitlines() if not line.startswith(("#", ">")))
        prose = re.sub(r"\[\[([^|\]]+)\|([^\]]+)\]\]", r"\2", prose)
        prose = re.sub(r"\[\[([^\]]+)\]\]", r"\1", prose)
        return {
            "id": page_id,
            "title": title,
            "markdown": markdown,
            "revision": revision,
            "excerpt": " ".join(prose.split())[:220],
        }

    def get_page(self, page_id: str) -> dict[str, Any] | None:
        self._validate_id(page_id)
        head = self._head()
        data = self._blob(head, f"pages/{page_id}.md")
        revision = self._blob(head, f"revisions/{page_id}")
        return (
            self._page(page_id, data, revision.decode() if revision else "")
            if data is not None
            else None
        )

    def _pages(self, head: str) -> list[dict[str, Any]]:
        blobs = self._snapshot_blobs(head, "pages/", "revisions/")
        pages = []
        for name, data in blobs.items():
            if name.startswith("pages/") and name.endswith(".md"):
                page_id = name.removeprefix("pages/").removesuffix(".md")
                revision = blobs.get(f"revisions/{page_id}", b"").decode()
                pages.append(self._page(page_id, data, revision))
        return sorted(pages, key=lambda page: (page["title"].casefold(), page["id"]))

    def _snapshot_blobs(self, head: str, *prefixes: str) -> dict[str, bytes]:
        """Read one tree with two Git processes, rather than four per page."""
        if not head:
            return {}
        rows = self._git("ls-tree", "-r", "-z", head, "--", *prefixes)
        entries: list[tuple[str, bytes]] = []
        for row in rows.split(b"\0"):
            if row:
                metadata, raw_path = row.split(b"\t", 1)
                _, kind, sha = metadata.split()
                if kind == b"blob":
                    entries.append((raw_path.decode(), sha))
        batch = self._git("cat-file", "--batch", data=b"".join(sha + b"\n" for _, sha in entries))
        blobs: dict[str, bytes] = {}
        offset = 0
        for path, _ in entries:
            end = batch.index(b"\n", offset)
            size = int(batch[offset:end].split()[2])
            offset = end + 1
            blobs[path] = batch[offset : offset + size]
            offset += size + 1
        return blobs

    def list_pages(self) -> list[dict[str, Any]]:
        return self._pages(self._head())

    def search(self, query: str) -> list[dict[str, Any]]:
        terms = query.casefold().strip().split()
        if not terms:
            return []
        pages = self.list_pages()
        hits = [
            p for p in pages if all(t in (p["id"] + " " + p["markdown"]).casefold() for t in terms)
        ]
        return sorted(
            hits,
            key=lambda p: (
                0 if query.casefold() in {p["id"].casefold(), p["title"].casefold()} else 1,
                p["title"].casefold(),
            ),
        )[:50]

    def graph(self) -> dict[str, Any]:
        result: dict[str, Any] = self.snapshot()["graph"]
        return result

    def snapshot(self) -> dict[str, Any]:
        """Capture content and its derived graph at one immutable Git commit."""
        head = self._head()
        pages = self._pages(head)
        return {"revision": head or None, "pages": pages, "graph": self._graph(pages, head)}

    @staticmethod
    def _graph(pages: list[dict[str, Any]], head: str) -> dict[str, Any]:
        ids = {p["id"] for p in pages}
        titles: dict[str, set[str]] = {}
        for page in pages:
            titles.setdefault(page["title"].casefold(), set()).add(page["id"])
        edges: set[tuple[str, str, str | None]] = set()
        missing: set[tuple[str, str]] = set()
        ambiguous: set[tuple[str, str, tuple[str, ...]]] = set()
        for page in pages:
            prose = prose_links(page["markdown"])
            links: list[tuple[str, str | None]] = [
                (match.group(2), re.sub(r"[^\w]+", "_", match.group(1).strip().lower()).strip("_"))
                for match in TYPED_LINK_RE.finditer(prose)
            ]
            links.extend((match.group(1), None) for match in LINK_RE.finditer(prose))
            outgoing: set[tuple[str, str | None]] = set()
            for raw_target, rel in links:
                target = raw_target.split("#", 1)[0].strip()
                if not target:
                    # [[#Heading]] is an explicit link within this page.
                    if raw_target.strip().startswith("#"):
                        target = page["id"]
                    else:
                        continue
                if target in ids:
                    resolved = target
                else:
                    candidates = titles.get(target.casefold(), set())
                    if len(candidates) > 1:
                        ambiguous.add((page["id"], target, tuple(sorted(candidates))))
                        continue
                    if not candidates:
                        missing.add((page["id"], target))
                        continue
                    resolved = next(iter(candidates))
                outgoing.add((resolved, rel))
            typed_targets = {target for target, rel in outgoing if rel is not None}
            edges.update(
                (page["id"], target, rel)
                for target, rel in outgoing
                if rel is not None or target not in typed_targets
            )
        return {
            "nodes": [{"id": p["id"], "title": p["title"]} for p in pages],
            "edges": [
                {"source": a, "target": b, "type": "wikilink", **({"rel": rel} if rel else {})}
                for a, b, rel in sorted(edges, key=lambda edge: (edge[0], edge[1], edge[2] or ""))
            ],
            "missing_targets": [{"source": a, "target": b} for a, b in sorted(missing)],
            "ambiguous_targets": [
                {"source": a, "target": b, "candidates": list(candidates)}
                for a, b, candidates in sorted(ambiguous)
            ],
            "status": "current",
            "source": "markdown",
            "revision": head or None,
        }

    def save_page(
        self,
        page_id: str,
        markdown: str,
        base_revision: str | None,
        request_id: str,
    ) -> dict[str, Any]:
        return self._mutate(page_id, markdown, base_revision, request_id)

    def delete_page(
        self,
        page_id: str,
        base_revision: str,
        request_id: str,
    ) -> dict[str, Any]:
        return self._mutate(page_id, None, base_revision, request_id)

    def _mutate(
        self,
        page_id: str,
        markdown: str | None,
        base_revision: str | None,
        request_id: str,
    ) -> dict[str, Any]:
        self._validate_id(page_id)
        if not request_id.strip() or len(request_id) > 200:
            raise WikiError(
                "invalid_request_id", "Provide a stable request ID up to 200 characters."
            )
        data = markdown.encode() if markdown is not None else None
        if data is not None and len(data) > MAX_BYTES:
            raise WikiError("content_too_large", "Pages are limited to one megabyte.")
        payload = json.dumps([page_id, markdown, base_revision], ensure_ascii=False).encode()
        fingerprint = hashlib.sha256(payload).hexdigest()
        request_path = f"requests/{hashlib.sha256(request_id.encode()).hexdigest()}.json"
        page_path = f"pages/{page_id}.md"
        # Retry unrelated concurrent writes. The page's base stays fixed on every retry.
        for _ in range(8):
            head = self._head()
            recorded = self._blob(head, request_path)
            if recorded:
                receipt = json.loads(recorded)
                if receipt["fingerprint"] != fingerprint:
                    raise WikiError("request_id_reused", "This request ID has a different payload.")
                return dict(receipt["result"])
            old = self._blob(head, page_path)
            revision_blob = self._blob(head, f"revisions/{page_id}")
            current = revision_blob.decode() if old is not None and revision_blob else None
            if current != base_revision:
                raise WikiError(
                    "revision_conflict",
                    "The page changed. Read it again before saving.",
                    current_revision=current,
                )
            if data is None and old is None:
                raise WikiError("not_found", "The page no longer exists.")
            new_revision = hashlib.sha256((head + fingerprint + request_id).encode()).hexdigest()
            result: dict[str, Any] = (
                self._page(page_id, data, new_revision) if data is not None else {"id": page_id}
            )
            result.update(
                {
                    "publication": "saved" if data is not None else "deleted",
                    "index": {"graph": "pending", "vector": "pending"},
                    "remote_sync": "not_configured",
                    "request_id": request_id,
                }
            )
            receipt_data = json.dumps(
                {"fingerprint": fingerprint, "result": result}, ensure_ascii=False
            ).encode()
            with tempfile.TemporaryDirectory(prefix="wiki-index-") as tmp:
                env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
                self._git("read-tree", head if head else "--empty", env=env)
                if data is None:
                    deletion = f"0 {'0' * 40}\t{page_path}\n0 {'0' * 40}\trevisions/{page_id}\n"
                    self._git("update-index", "--index-info", data=deletion.encode(), env=env)
                else:
                    blob = self._git("hash-object", "-w", "--stdin", data=data).decode().strip()
                    self._git(
                        "update-index", "--add", "--cacheinfo", "100644", blob, page_path, env=env
                    )
                    revision_sha = (
                        self._git("hash-object", "-w", "--stdin", data=new_revision.encode())
                        .decode()
                        .strip()
                    )
                    self._git(
                        "update-index",
                        "--add",
                        "--cacheinfo",
                        "100644",
                        revision_sha,
                        f"revisions/{page_id}",
                        env=env,
                    )
                blob = self._git("hash-object", "-w", "--stdin", data=receipt_data).decode().strip()
                self._git(
                    "update-index", "--add", "--cacheinfo", "100644", blob, request_path, env=env
                )
                tree = self._git("write-tree", env=env).decode().strip()
                parents = ["-p", head] if head else []
                commit = self._git(
                    "commit-tree",
                    tree,
                    *parents,
                    data=f"wiki: {result['publication']} {page_id}\n".encode(),
                )
                new_head = commit.decode().strip()
                # A single atomic ref transition publishes content and its retry receipt.
                self._git("update-ref", REF, new_head, head or "0" * 40, check=False)
                if self._head() == new_head:
                    return result
                # A later successful writer can already have advanced our commit.
                recorded = self._blob(self._head(), request_path)
                if recorded and json.loads(recorded)["fingerprint"] == fingerprint:
                    return dict(json.loads(recorded)["result"])
        raise WikiError("busy", "Concurrent writes prevented publication. Retry the same request.")

    def history(self, page_id: str) -> list[dict[str, str]]:
        self._validate_id(page_id)
        head = self._head()
        if not head:
            return []
        format_arg = "--format=%H%x09%aI%x09%at%x09%s"
        rows = (
            self._git("log", "-20", "--first-parent", format_arg, head, "--", f"pages/{page_id}.md")
            .decode()
            .splitlines()
        )
        # Imports retain original objects and their path map. Include source
        # history even though managed page paths can differ from source paths.
        for data in self._snapshot_blobs(head, "imports/").values():
            provenance = json.loads(data)
            path = provenance["paths"].get(page_id)
            source = provenance["source_revision"]
            if path and source:
                rows.extend(
                    self._git("log", "-20", format_arg, source, "--", path).decode().splitlines()
                )
        seen: set[str] = set()
        changes = []
        for row in rows:
            commit, date, timestamp, message = row.split("\t", 3)
            if commit not in seen:
                seen.add(commit)
                changes.append(
                    (int(timestamp), {"commit": commit, "date": date, "message": message})
                )
        return [
            change for _, change in sorted(changes, key=lambda item: item[0], reverse=True)[:20]
        ]
