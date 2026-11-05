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
   not fail because the configured Git host is unreachable.

Initialized via setup() on container start.
"""
import logging
import shlex
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse

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
    """Return an authenticated URL for backwards-compatible callers.

    GitSync itself no longer uses this helper because credentials in a remote
    URL are persisted in ``.git/config``.  Keeping it here avoids breaking
    integrations that imported the old helper, while also making the old
    implementation safe for tokens containing URL-significant characters.
    """
    parsed = urlparse(url)
    authed = parsed._replace(netloc=f"oauth2:{quote(pat, safe='')}@{parsed.netloc}")
    return urlunparse(authed)


def _without_http_credentials(url: str) -> str:
    """Remove HTTP(S) userinfo before storing a remote URL in Git config."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return url

    hostname = parsed.hostname or ""
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    if parsed.port:
        hostname = f"{hostname}:{parsed.port}"
    return urlunparse(parsed._replace(netloc=hostname))


class GitSync:
    def __init__(self) -> None:
        self._vault_path = Path(settings.VAULT_PATH)
        self._url = settings.vault_git_url
        self._remote_url = _without_http_credentials(self._url)
        self._provider = settings.VAULT_GIT_PROVIDER.strip().lower() or "github"
        self._branch = settings.VAULT_GIT_BRANCH.strip()
        self._auth_method = settings.VAULT_GIT_AUTH_METHOD.strip().lower() or "auto"
        self._http_username = settings.VAULT_GIT_HTTP_USERNAME.strip()
        self._http_token = (
            settings.VAULT_GIT_HTTP_ACCESS_TOKEN
            or settings.VAULT_GIT_HTTP_TOKEN
            or (settings.VAULT_GITHUB_PAT if self._provider == "github" else "")
        )
        self._ssh_key_path = settings.VAULT_GIT_SSH_KEY_PATH.strip()
        self._ssh_key = settings.VAULT_GIT_SSH_KEY
        self._ssh_known_hosts_path = settings.VAULT_GIT_SSH_KNOWN_HOSTS_PATH.strip()

    @property
    def _effective_auth_method(self) -> str:
        """Resolve ``auto`` without making the Git host part of the code path."""
        if self._auth_method in {"none", "http", "ssh"}:
            return self._auth_method
        if self._auth_method != "auto":
            logger.warning(
                "Unknown VAULT_GIT_AUTH_METHOD=%r — falling back to auto.",
                self._auth_method,
            )
        parsed = urlparse(self._url)
        if parsed.scheme == "ssh" or self._url.startswith("git@"):
            return "ssh"
        return "http" if self._http_token else "none"

    def _default_http_username(self) -> str:
        """Return the conventional username for token-based HTTP Git auth."""
        if self._http_username:
            return self._http_username
        if self._provider == "bitbucket":
            # Bitbucket repository/workspace access tokens use this sentinel.
            # API tokens and app passwords can override it through config.
            return "x-token-auth"
        if self._provider == "github":
            return "oauth2"
        return "git"

    @contextmanager
    def _git_environment(self) -> Generator[dict[str, str], None, None]:
        """Create per-process Git auth settings without leaking secrets.

        HTTP credentials are supplied through a short-lived ``GIT_ASKPASS``
        helper instead of the remote URL.  SSH keys may be mounted as files or
        injected as multiline secrets; in both cases the key is only present
        for the duration of the Git operation.
        """
        env: dict[str, str] = {"GIT_TERMINAL_PROMPT": "0"}
        with tempfile.TemporaryDirectory(prefix="secondbrain-git-") as temp_dir:
            temp_path = Path(temp_dir)

            if self._effective_auth_method == "http" and self._http_token:
                askpass = temp_path / "askpass.sh"
                askpass.write_text(
                    "#!/bin/sh\n"
                    "case \"$1\" in\n"
                    "  *[Uu]sername*|*[Uu]ser*) printf '%s\\n' \"$SECOND_BRAIN_GIT_USERNAME\" ;;\n"
                    "  *) printf '%s\\n' \"$SECOND_BRAIN_GIT_PASSWORD\" ;;\n"
                    "esac\n",
                    encoding="utf-8",
                )
                askpass.chmod(0o700)
                env.update(
                    {
                        "GIT_ASKPASS": str(askpass),
                        "SECOND_BRAIN_GIT_USERNAME": self._default_http_username(),
                        "SECOND_BRAIN_GIT_PASSWORD": self._http_token,
                    }
                )

            if self._effective_auth_method == "ssh":
                key_path = self._ssh_key_path
                if self._ssh_key and not key_path:
                    inline_key = temp_path / "ssh-key"
                    inline_key.write_text(self._ssh_key, encoding="utf-8")
                    inline_key.chmod(0o600)
                    key_path = str(inline_key)

                ssh_command = ["ssh"]
                if key_path:
                    if not Path(key_path).is_file():
                        logger.warning("Configured SSH key does not exist: %s", key_path)
                    ssh_command.extend(["-i", key_path, "-o", "IdentitiesOnly=yes"])
                ssh_command.extend(["-o", "BatchMode=yes"])
                if self._ssh_known_hosts_path:
                    ssh_command.extend(
                        [
                            "-o",
                            f"UserKnownHostsFile={self._ssh_known_hosts_path}",
                            "-o",
                            "StrictHostKeyChecking=yes",
                        ]
                    )
                env["GIT_SSH_COMMAND"] = " ".join(shlex.quote(part) for part in ssh_command)

            yield env

    @contextmanager
    def _repo_environment(self, repo: git.Repo) -> Generator[None, None, None]:
        """Apply auth settings only to commands executed by ``repo``."""
        with self._git_environment() as env, repo.git.custom_environment(**env):
            yield

    def setup(self) -> bool:
        """Clones the vault repo on container start if it doesn't exist yet.

        Returns True if the vault was freshly cloned (full reindex needed).
        """
        if not self._url:
            logger.warning("No vault Git URL configured — no Git sync.")
            self._vault_path.mkdir(parents=True, exist_ok=True)
            return False

        if (self._vault_path / ".git").exists():
            repo = self._repo()
            if repo is not None:
                self._ensure_auth_remote(repo)
                if self._branch:
                    self._ensure_configured_branch(repo)
            logger.info("Vault already exists — pull handled by reindex_after_pull task.")
            return False

        logger.info(
            "Cloning vault Git repository to %s (provider=%s, branch=%s, auth=%s) …",
            self._vault_path,
            self._provider,
            self._branch or "remote default",
            self._effective_auth_method,
        )
        with tracer.start_as_current_span("git.clone"):
            try:
                with self._git_environment() as env:
                    if self._branch:
                        git.Repo.clone_from(
                            self._remote_url,
                            str(self._vault_path),
                            env=env,
                            branch=self._branch,
                        )
                    else:
                        git.Repo.clone_from(self._remote_url, str(self._vault_path), env=env)
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
        """Keep ``origin`` credential-free and pointed at the configured URL."""
        if not self._remote_url:
            return
        try:
            origin = repo.remotes["origin"]
        except IndexError:
            origin = repo.create_remote("origin", self._remote_url)
        else:
            if origin.url != self._remote_url:
                origin.set_url(self._remote_url)

    def _ensure_configured_branch(self, repo: git.Repo) -> bool:
        """Switch an existing clone to the explicitly configured target branch.

        A dirty working tree is deliberately not switched: changing branches
        underneath local edits could hide vault data. The regular pull/push
        flow retries the operation after the tree is clean.
        """
        if not self._branch:
            return True

        try:
            if not repo.head.is_detached and repo.active_branch.name == self._branch:
                return True
        except (TypeError, ValueError):
            pass

        if repo.is_dirty(untracked_files=True):
            logger.warning(
                "Cannot switch vault to configured branch %r while the working tree is dirty.",
                self._branch,
            )
            return False

        try:
            with self._repo_environment(repo):
                if self._branch in [head.name for head in repo.heads]:
                    repo.git.checkout(self._branch)
                else:
                    repo.git.fetch(
                        "origin",
                        f"+refs/heads/{self._branch}:refs/remotes/origin/{self._branch}",
                    )
                    repo.git.checkout(
                        "-b", self._branch, f"origin/{self._branch}"
                    )
            logger.info("Using configured vault branch %s.", self._branch)
            return True
        except git.GitCommandError as exc:
            logger.error(
                "Could not switch vault to branch %r: %s",
                self._branch,
                exc,
            )
            return False

    def _merge_remote(self, repo: git.Repo) -> bool:
        """fetch + merge origin (local wins on conflicting lines).

        Returns True if the merge succeeded (or there was nothing to merge).
        """
        try:
            with self._repo_environment(repo):
                if self._branch:
                    repo.git.fetch(
                        "origin",
                        f"+refs/heads/{self._branch}:refs/remotes/origin/{self._branch}",
                    )
                    repo.git.merge("--no-edit", "-X", "ours", f"origin/{self._branch}")
                else:
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
                self._ensure_auth_remote(repo)
                if not self._ensure_configured_branch(repo):
                    return
                self._commit_all(repo, "chore: autosave local vault state")
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
                self._ensure_auth_remote(repo)
                if not self._ensure_configured_branch(repo):
                    return [], []
                self._commit_all(repo, "chore: autosave local vault state")
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
                self._ensure_auth_remote(repo)
                if not self._ensure_configured_branch(repo):
                    return
                self._commit_all(repo, message)
                # Integrate remote first so the push is a fast-forward for the
                # remote even when another instance pushed in the meantime.
                self._merge_remote(repo)
                # repo.git.push raises on rejection (Remote.push() would not!)
                with self._repo_environment(repo):
                    if self._branch:
                        repo.git.push("origin", f"HEAD:refs/heads/{self._branch}")
                    else:
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
