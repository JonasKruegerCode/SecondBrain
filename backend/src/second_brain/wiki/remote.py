"""Explicit snapshot publication through an isolated Git object store."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import closing
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

from second_brain.wiki.importer import _published_result, import_vault
from second_brain.wiki.store import MAX_BYTES, WikiError, WikiStore


class ManagedGitSync:
    """A caller-selected target; URLs and credentials are never persisted."""

    def __init__(self, store: WikiStore, remote: str, branch: str, prefix: str = "") -> None:
        self.store = store
        self.remote = remote
        if not remote or any(ord(c) < 32 for c in remote) or remote.startswith("-"):
            raise WikiError("invalid_remote", "Choose an explicit safe Git target.")
        if remote.startswith("/"):
            target = Path(remote).resolve()
            if target.is_relative_to(store.path) or store.path.is_relative_to(target):
                raise WikiError("invalid_remote", "Target and managed vault must be separate.")
        elif re.fullmatch(r"git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+", remote):
            pass
        else:
            try:
                url = urlsplit(remote)
            except ValueError as exc:
                raise WikiError("invalid_remote", "Choose a safe Git URL.") from exc
            if (
                url.scheme not in {"https", "http", "ssh"}
                or not url.hostname
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]*", url.hostname)
                or "?" in remote
                or "#" in remote
                or url.password is not None
                or url.query
                or url.fragment
                or (
                    url.username is not None and not (url.scheme == "ssh" and url.username == "git")
                )
            ):
                raise WikiError("invalid_remote", "Target URLs must not contain credentials.")
        if (
            not branch
            or branch.startswith("-")
            or subprocess.run(
                ["git", "check-ref-format", "refs/heads/" + branch], capture_output=True
            ).returncode
        ):
            raise WikiError("invalid_branch", "Choose an explicit valid branch.")
        if prefix and (
            prefix.startswith("/")
            or "\\" in prefix
            or any(p in {"", ".", "..", ".git"} for p in prefix.split("/"))
            or any(ord(c) < 32 for c in prefix)
        ):
            raise WikiError("invalid_prefix", "Choose a safe relative page prefix.")
        self.branch = branch
        self.prefix = prefix + "/" if prefix else ""
        self.repo = store.path / ".wiki-remote.git"
        self.receipts = store.path / ".wiki-remote.sqlite3"
        if self.repo.is_symlink() or self.receipts.is_symlink():
            raise WikiError("invalid_vault", "Remote storage must not be a symlink.")
        if not self.repo.exists():
            self._run("init", "--bare", str(self.repo), bare=False)
        with closing(sqlite3.connect(self.receipts)) as db, db:
            db.execute(
                "CREATE TABLE IF NOT EXISTS requests "
                "(id TEXT PRIMARY KEY, fingerprint TEXT, commit_id TEXT, result TEXT)"
            )
            if "result" not in {row[1] for row in db.execute("PRAGMA table_info(requests)")}:
                db.execute("ALTER TABLE requests ADD COLUMN result TEXT")

    def _run(
        self,
        *args: str,
        data: bytes | None = None,
        bare: bool = True,
        env: dict[str, str] | None = None,
        check: bool = True,
        hooks_path: Path | None = None,
    ) -> bytes:
        clean_env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        clean_env.update(
            {
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_TERMINAL_PROMPT": "0",
                "GIT_NO_LAZY_FETCH": "1",
                "GIT_AUTHOR_NAME": "Managed Wiki",
                "GIT_AUTHOR_EMAIL": "wiki@localhost",
                "GIT_COMMITTER_NAME": "Managed Wiki",
                "GIT_COMMITTER_EMAIL": "wiki@localhost",
                "GIT_LITERAL_PATHSPECS": "1",
                **(env or {}),
            }
        )
        command = [
            "git",
            "-c",
            "core.hooksPath=" + str(hooks_path or os.devnull),
            "-c",
            "protocol.ext.allow=never",
        ]
        if bare:
            command += ["--git-dir", str(self.repo)]
        try:
            result = subprocess.run(
                command + list(args),
                input=data,
                capture_output=True,
                env=clean_env,
                check=False,
                timeout=45,
            )
        except subprocess.TimeoutExpired as exc:
            raise WikiError("remote_unavailable", "Git target operation timed out.") from exc
        if check and result.returncode:
            raise WikiError(
                "remote_unavailable", "Git target operation failed; no overwrite attempted."
            )
        return result.stdout

    def _fetch(self) -> str | None:
        ref = "refs/heads/" + self.branch
        rows = self._run("ls-remote", "--heads", "--", self.remote, ref).splitlines()
        if not rows:
            return None
        self._run("fetch", "--no-tags", "--no-write-fetch-head", "--", self.remote, ref)
        head = rows[0].split()[0].decode()
        # A branch can move between discovery and fetch. Verify the named object exists;
        # then verify the pointer again at the push boundary.
        self._run("cat-file", "-e", head + "^{commit}")
        return head

    def inspect(self) -> dict[str, Any]:
        """Verify the selected pointer once; the returned observation is cached."""
        return {"observed_remote_revision": self._fetch(), "remote_status": "cached_verification"}

    def _markdown(self, head: str) -> dict[str, tuple[str, bytes]]:
        pages: dict[str, tuple[str, bytes]] = {}
        rows = self._run("ls-tree", "-r", "-z", head)
        for row in rows.split(b"\0"):
            if not row:
                continue
            metadata, raw_path = row.split(b"\t", 1)
            try:
                name = raw_path.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise WikiError("invalid_remote_snapshot", "Paths must be UTF-8.") from exc
            if not name.startswith(self.prefix) or not name.endswith(".md"):
                continue
            if any(p in {".", "..", ".git"} for p in PurePosixPath(name).parts) or "\\" in name:
                raise WikiError("invalid_remote_snapshot", "Unsafe Markdown path.")
            mode, kind, oid = metadata.decode().split()
            if mode not in {"100644", "100755"} or kind != "blob":
                raise WikiError("invalid_remote_snapshot", "Markdown must be a regular blob.")
            page_id = PurePosixPath(name).stem
            WikiStore._validate_id(page_id)
            if page_id in pages:
                raise WikiError("ambiguous_import", "Duplicate Markdown page IDs.")
            if int(self._run("cat-file", "-s", oid)) > MAX_BYTES:
                raise WikiError("content_too_large", "Page exceeds one megabyte.")
            content = self._run("cat-file", "blob", oid)
            try:
                content.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise WikiError("invalid_remote_snapshot", "Markdown must be UTF-8.") from exc
            pages[page_id] = (name, content)
        return pages

    def _fingerprint(
        self, operation: str, base: str | None, expected: str | None, request_id: str
    ) -> str:
        if not request_id.strip() or len(request_id) > 200:
            raise WikiError("invalid_request_id", "Provide a stable request ID.")
        return hashlib.sha256(
            json.dumps(
                [
                    operation,
                    base,
                    expected,
                    hashlib.sha256(self.remote.encode()).hexdigest(),
                    self.branch,
                    self.prefix,
                ]
            ).encode()
        ).hexdigest()

    def push(
        self, base_revision: str, expected_remote_revision: str | None, request_id: str
    ) -> dict[str, Any]:
        fingerprint = self._fingerprint("push", base_revision, expected_remote_revision, request_id)
        with closing(sqlite3.connect(self.receipts, timeout=30)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute(
                "SELECT fingerprint, commit_id, result FROM requests WHERE id=?", (request_id,)
            ).fetchone()
            if receipt and receipt[0] != fingerprint:
                raise WikiError("request_id_reused", "Request payload changed.")
            if receipt and receipt[2]:
                acknowledged: dict[str, Any] = json.loads(receipt[2])
                return acknowledged
            observed = self._fetch()
            if receipt:
                commit = str(receipt[1])
                if observed and self._is_ancestor(commit, observed):
                    return self._ack(db, request_id, base_revision, commit, observed)
            else:
                if self.store._head() != base_revision:
                    raise WikiError("revision_conflict", "Managed snapshot changed.")
                if observed != expected_remote_revision:
                    raise WikiError("remote_conflict", "Remote branch changed.")
                old_pages = self._markdown(observed) if observed else {}
                blobs = self.store._snapshot_blobs(base_revision, "pages/")
                with tempfile.TemporaryDirectory(prefix="wiki-export-") as tmp:
                    env = {"GIT_INDEX_FILE": str(Path(tmp) / "index")}
                    self._run("read-tree", observed or "--empty", env=env)
                    for name, _ in old_pages.values():
                        self._run(
                            "update-index",
                            "-z",
                            "--index-info",
                            data=b"0 " + b"0" * 40 + b"\t" + name.encode() + b"\0",
                            env=env,
                        )
                    for name, content in blobs.items():
                        page_id = name.removeprefix("pages/").removesuffix(".md")
                        WikiStore._validate_id(page_id)
                        oid = (
                            self._run("hash-object", "-w", "--stdin", data=content).decode().strip()
                        )
                        self._run(
                            "update-index",
                            "--add",
                            "--cacheinfo",
                            "100644",
                            oid,
                            self.prefix + page_id + ".md",
                            env=env,
                        )
                    tree = self._run("write-tree", env=env).decode().strip()
                    parents = ["-p", observed] if observed else []
                    commit = (
                        self._run("commit-tree", tree, *parents, data=b"wiki: Markdown snapshot\n")
                        .decode()
                        .strip()
                    )
                self._run(
                    "update-ref",
                    "refs/prepared/" + hashlib.sha256(request_id.encode()).hexdigest(),
                    commit,
                )
                db.execute(
                    "INSERT INTO requests (id, fingerprint, commit_id) VALUES (?, ?, ?)",
                    (request_id, fingerprint, commit),
                )
                db.commit()  # Prepared object and receipt survive a lost push response.
            if self._fetch() != expected_remote_revision:
                raise WikiError(
                    "remote_conflict", "Remote branch changed; prepared snapshot retained."
                )
            self._push(commit, expected_remote_revision)
            return self._ack(db, request_id, base_revision, commit, commit)

    def _push(self, commit: str, expected: str | None) -> None:
        # Git supplies its advertised remote object ID to pre-push. Compare it
        # before sending objects; receive-pack then CAS-checks that advertised ID.
        # This closes deletion/rewind races without a force or lease option.
        with tempfile.TemporaryDirectory(prefix="wiki-push-guard-") as tmp:
            hooks = Path(tmp)
            hook = hooks / "pre-push"
            wanted = [commit, "refs/heads/" + self.branch, expected or "0" * 40]
            guard = hooks / "guard.py"
            guard.write_text(
                "import sys\n"
                "rows = [line.split() for line in sys.stdin if line.strip()]\n"
                "wanted = " + repr(wanted) + "\n"
                "ok = len(rows) == 1 and len(rows[0]) == 4 and rows[0][1:] == wanted\n"
                "sys.exit(0 if ok else 1)\n",
                encoding="utf-8",
            )
            hook.write_text(
                "#!/bin/sh\nexec "
                + shlex.quote(sys.executable)
                + " "
                + shlex.quote(str(guard))
                + "\n",
                encoding="utf-8",
            )
            hook.chmod(0o700)
            self._run(
                "push", "--", self.remote, commit + ":refs/heads/" + self.branch, hooks_path=hooks
            )

    def _is_ancestor(self, commit: str, observed: str) -> bool:
        return commit in self._run("rev-list", observed).decode().splitlines()

    @staticmethod
    def _ack(
        db: sqlite3.Connection, request_id: str, base: str, commit: str, observed: str
    ) -> dict[str, Any]:
        result = {
            "content_revision": base,
            "request_id": request_id,
            "publication": "pushed",
            "published_revision": commit,
            "last_verified_remote_revision": observed,
            "remote_status": "cached_verification",
        }
        db.execute("UPDATE requests SET result=? WHERE id=?", (json.dumps(result), request_id))
        db.commit()
        return result

    def pull(
        self, base_revision: str | None, expected_remote_revision: str, request_id: str
    ) -> dict[str, Any]:
        fingerprint = self._fingerprint("pull", base_revision, expected_remote_revision, request_id)
        with closing(sqlite3.connect(self.receipts)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            receipt = db.execute(
                "SELECT fingerprint FROM requests WHERE id=?", (request_id,)
            ).fetchone()
            if receipt and receipt[0] != fingerprint:
                raise WikiError("request_id_reused", "Request payload changed.")
            db.execute(
                "INSERT OR IGNORE INTO requests (id, fingerprint, commit_id) VALUES (?, ?, ?)",
                (request_id, fingerprint, expected_remote_revision),
            )
        import_id = (
            "remote-pull:" + fingerprint + ":" + hashlib.sha256(request_id.encode()).hexdigest()
        )
        request_path = "requests/" + hashlib.sha256(import_id.encode()).hexdigest() + ".json"
        recorded = self.store._blob(self.store._head(), request_path)
        if recorded:
            prior = json.loads(recorded)
            return {
                **_published_result(self.store, request_path, prior["fingerprint"]),
                "request_id": request_id,
                "remote_sync": "pulled",
                "last_verified_remote_revision": expected_remote_revision,
                "remote_status": "cached_verification",
            }
        if self._fetch() != expected_remote_revision:
            raise WikiError("remote_conflict", "Remote branch changed.")
        pages = self._markdown(expected_remote_revision)
        # Reconstruct a clean isolated repository from frozen objects. No checkout,
        # remote configuration, hooks, or arbitrary non-Markdown content is executed.
        with tempfile.TemporaryDirectory(prefix="wiki-pull-") as tmp:
            source = Path(tmp)
            self._run("init", str(source), bare=False)
            self._run(
                "-C",
                str(source),
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                str(self.repo),
                expected_remote_revision,
                bare=False,
            )
            self._run("-C", str(source), "update-ref", "HEAD", expected_remote_revision, bare=False)
            # Importer reads committed blobs; populate the complete index/worktree
            # only through Git's safe tree handling, with hooks disabled.
            self._run("-C", str(source), "reset", "--hard", expected_remote_revision, bare=False)
            del pages
            result = import_vault(
                self.store,
                source,
                prefix=self.prefix.rstrip("/"),
                base_revision=base_revision,
                request_id=import_id,
            )
        return {
            **result,
            "request_id": request_id,
            "remote_sync": "pulled",
            "last_verified_remote_revision": expected_remote_revision,
            "remote_status": "cached_verification",
        }
