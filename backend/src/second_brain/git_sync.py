"""
GitSync — clone, pull, and push the vault repo.

Initialized via setup() on container start.
push() is called after every write operation in the worker.
"""
import logging
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import git

from second_brain.core.config import settings

logger = logging.getLogger(__name__)


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
        try:
            git.Repo.clone_from(auth_url, str(self._vault_path))
            logger.info("Vault repo cloned.")
            return True
        except git.GitCommandError as exc:
            logger.warning("Git clone failed — running with local vault only: %s", exc)
            self._vault_path.mkdir(parents=True, exist_ok=True)
            return False

    def pull(self) -> None:
        """git pull --rebase — call before each read."""
        if not self._url:
            return
        try:
            repo = git.Repo(str(self._vault_path))
            repo.git.pull("--rebase")
            logger.debug("Vault pulled.")
        except git.GitCommandError as exc:
            logger.warning("git pull failed: %s", exc)

    def pull_and_diff(
        self, wiki_prefix: str = "1_knowledge/wiki/"
    ) -> tuple[list[str], list[str]]:
        """Pull and return (changed_slugs, deleted_slugs) within wiki_prefix.

        Only files that actually changed between the old and new HEAD are returned,
        so callers can re-embed/delete exactly those pages without touching the rest.
        """
        if not self._url:
            return [], []
        try:
            repo = git.Repo(str(self._vault_path))
        except git.InvalidGitRepositoryError:
            logger.warning("Vault at %s is not a git repo — skipping pull.", self._vault_path)
            return [], []
        try:
            old_head = repo.head.commit.hexsha
            repo.git.pull("--rebase")
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
            return changed, deleted
        except git.GitCommandError as exc:
            logger.warning("git pull failed: %s", exc)
            return [], []

    def push(self, message: str) -> None:
        """git add -A && git commit && git push — call after every write."""
        if not self._url:
            logger.debug("No Git sync configured — skipping push.")
            return
        try:
            repo = git.Repo(str(self._vault_path))
            repo.git.add("-A")
            if not repo.index.diff("HEAD") and not repo.untracked_files:
                logger.debug("No changes — skipping commit.")
                return
            repo.index.commit(message)
            if self._pat:
                auth_url = _authenticated_url(self._url, self._pat)
                repo.remotes.origin.set_url(auth_url)
            repo.remotes.origin.push()
            logger.info("Vault pushed: %s", message)
        except git.GitCommandError as exc:
            logger.error("git push failed: %s", exc)


_instance: GitSync | None = None


def get_git_sync() -> GitSync:
    global _instance
    if _instance is None:
        _instance = GitSync()
    return _instance
