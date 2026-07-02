"""
GitSync — clone, pull, and push the vault repo.

Design principles (learned from a rebase that sat stuck in prod for months):

1. Sync BEFORE every write: callers pull first, so edits always happen on top
   of the freshest remote state.
2. Merge, never rebase. A conflicted rebase leaves the repo in a detached
   in-progress state that silently breaks every later pull AND push. Merges
   either succeed or can always be aborted cleanly. Vault history is data
   history — merge commits are fine.
3. Conflicts auto-resolve with `-X ours`: this instance is the actively
   writing one, so its file state wins on overlapping lines. Nothing is lost
   silently — the remote side stays reachable in history.
4. Self-healing: every operation first aborts any leftover rebase/merge state
   so the repo can never stay stuck.
5. Failures are logged loudly, but never crash the caller — memory writes must
   not fail because GitHub is unreachable.

Initialized via setup() on container start.
"""
import logging
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import git
from git import Actor

from second_brain.core.config import settings
from second_brain.core.telemetry import get_tracer

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)

_COMMIT_NAME = "SecondBrain"
_COMMIT_EMAIL = "bot@secondbrain.local"
_COMMIT_ACTOR = Actor(_COMMIT_NAME, _COMMIT_EMAIL)


def _authenticated_url(url: str, pat: str) -> str:
    """Embeds the PAT as Basic Auth into the HTTPS URL."""
    parsed = urlparse(url)
    authed = parsed._replace(netloc=f"oauth2:{pat}@{parsed.netloc}")
    return urlunparse(authed)


class GitSync:
    def __init__(self) -> None:
        self._vault_path = Path(settings.VAULT_PATH)
        self._url = settings.VAULT_GITHUB_URL
        self._pat = settings.VAULT_GITHUB_PAT

    def setup(self) -> bool:
        """Clones the vault repo on container start if it doesn't exist yet.

        Returns True if the vault was freshly cloned (full reindex needed).
        """
        if not self._url:
            logger.warning("VAULT_GITHUB_URL not configured — no Git sync.")
            self._vault_path.mkdir(parents=True, exist_ok=True)
            return False

        if (self._vault_path / ".git").exists():
            logger.info("Vault already exists — pull handled by reindex_after_pull task.")
            return False

        auth_url = _authenticated_url(self._url, self._pat) if self._pat else self._url
        logger.info("Cloning vault repo to %s …", self._vault_path)
        with tracer.start_as_current_span("git.clone"):
            try:
                git.Repo.clone_from(auth_url, str(self._vault_path))
                logger.info("Vault repo cloned.")
                return True
            except git.GitCommandError as exc:
                logger.warning("Git clone failed — running with local vault only: %s", exc)
                self._vault_path.mkdir(parents=True, exist_ok=True)
                return False

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _repo(self) -> git.Repo | None:
        try:
            repo = git.Repo(str(self._vault_path))
        except (git.InvalidGitRepositoryError, git.NoSuchPathError):
            logger.warning("Vault at %s is not a git repo — skipping sync.", self._vault_path)
            return None
        self._ensure_identity(repo)
        return repo

    @staticmethod
    def _ensure_identity(repo: git.Repo) -> None:
        """git pull creates merge commits, which need a committer identity.

        Containers and CI runners have no global git config, so always write
        the bot identity into the repo config (idempotent).
        """
        with repo.config_writer() as writer:
            writer.set_value("user", "name", _COMMIT_NAME)
            writer.set_value("user", "email", _COMMIT_EMAIL)

    def _recover_stuck_state(self, repo: git.Repo) -> None:
        """Aborts leftover rebase/merge state so the repo can never stay stuck."""
        git_dir = Path(repo.git_dir)
        if (git_dir / "rebase-merge").exists() or (git_dir / "rebase-apply").exists():
            logger.error("Vault repo has a stale rebase in progress — aborting it.")
            try:
                repo.git.rebase("--abort")
            except git.GitCommandError as exc:
                logger.error("Could not abort stale rebase: %s", exc)
        if (git_dir / "MERGE_HEAD").exists():
            logger.error("Vault repo has an unfinished merge — aborting it.")
            try:
                repo.git.merge("--abort")
            except git.GitCommandError as exc:
                logger.error("Could not abort stale merge: %s", exc)

    def _commit_all(self, repo: git.Repo, message: str) -> bool:
        """add -A + commit. Returns True if a commit was created."""
        repo.git.add("-A")
        if not repo.index.diff("HEAD") and not repo.untracked_files:
            return False
        repo.index.commit(message, author=_COMMIT_ACTOR, committer=_COMMIT_ACTOR)
        return True

    def _ensure_auth_remote(self, repo: git.Repo) -> None:
        if self._pat:
            repo.remotes.origin.set_url(_authenticated_url(self._url, self._pat))

    def _merge_remote(self, repo: git.Repo) -> bool:
        """fetch + merge origin (local wins on conflicting lines).

        Returns True if the merge succeeded (or there was nothing to merge).
        """
        try:
            repo.git.pull("--no-rebase", "--no-edit", "-X", "ours")
            return True
        except git.GitCommandError as exc:
            # e.g. modify/delete conflicts that -X ours cannot resolve
            logger.error("git pull (merge) failed: %s — aborting merge state", exc)
            self._recover_stuck_state(repo)
            return False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def pull(self) -> None:
        """Sync with remote — call BEFORE reading or editing the vault.

        Local dirty state is committed first (nothing is ever stashed or
        dropped), then the remote is merged in.
        """
        if not self._url:
            return
        repo = self._repo()
        if repo is None:
            return
        with tracer.start_as_current_span("git.pull"):
            self._recover_stuck_state(repo)
            try:
                self._commit_all(repo, "chore: autosave local vault state")
                self._ensure_auth_remote(repo)
                self._merge_remote(repo)
            except git.GitCommandError as exc:
                logger.error("git pull failed: %s", exc)

    def pull_and_diff(
        self, wiki_prefix: str = "1_knowledge/wiki/"
    ) -> tuple[list[str], list[str]]:
        """Pull and return (changed_slugs, deleted_slugs) within wiki_prefix.

        Only files the pull actually brought in are returned, so callers can
        re-embed/delete exactly those pages without touching the rest.
        """
        if not self._url:
            return [], []
        repo = self._repo()
        if repo is None:
            return [], []
        with tracer.start_as_current_span("git.pull_and_diff") as span:
            self._recover_stuck_state(repo)
            try:
                self._commit_all(repo, "chore: autosave local vault state")
                self._ensure_auth_remote(repo)
                old_head = repo.head.commit.hexsha
                if not self._merge_remote(repo):
                    return [], []
                new_head = repo.head.commit.hexsha
                if old_head == new_head:
                    return [], []
                diff_output = repo.git.diff(
                    "--name-status", old_head, new_head, "--", wiki_prefix
                )
                changed: list[str] = []
                deleted: list[str] = []
                for line in diff_output.splitlines():
                    if not line.strip():
                        continue
                    parts = line.split("\t")
                    status = parts[0][0]  # A/M/D/R — take first char to normalize R100→R
                    path = parts[-1]      # last element is always the target path
                    if not path.endswith(".md"):
                        continue
                    slug = Path(path).stem
                    if status == "D":
                        deleted.append(slug)
                    else:
                        changed.append(slug)
                span.set_attribute("git.changed", len(changed))
                span.set_attribute("git.deleted", len(deleted))
                return changed, deleted
            except git.GitCommandError as exc:
                span.record_exception(exc)
                logger.error("git pull failed: %s", exc)
                return [], []

    def push(self, message: str) -> None:
        """commit + merge remote + push — call after every write operation."""
        if not self._url:
            logger.debug("No Git sync configured — skipping push.")
            return
        repo = self._repo()
        if repo is None:
            return
        with tracer.start_as_current_span("git.push") as span:
            self._recover_stuck_state(repo)
            try:
                self._commit_all(repo, message)
                self._ensure_auth_remote(repo)
                # Integrate remote first so the push is a fast-forward for the
                # remote even when another instance pushed in the meantime.
                self._merge_remote(repo)
                # repo.git.push raises on rejection (Remote.push() would not!)
                repo.git.push()
                logger.info("Vault pushed: %s", message)
            except git.GitCommandError as exc:
                span.record_exception(exc)
                logger.error("git push failed: %s", exc)


_instance: GitSync | None = None


def get_git_sync() -> GitSync:
    global _instance
    if _instance is None:
        _instance = GitSync()
    return _instance
