"""Existing vault Git settings and short-lived subprocess credentials.

Secret values never become command arguments, remote URLs or Git configuration.
This module does not load settings or contact Git until explicitly called.
"""

from __future__ import annotations

import os
import shlex
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path

from second_brain.wiki.store import WikiError


@dataclass(frozen=True)
class GitCredentials:
    method: str = "none"
    username: str = field(default="", repr=False)
    token: str = field(default="", repr=False)
    ssh_key_path: str = field(default="", repr=False)
    ssh_key: str = field(default="", repr=False)

    @contextmanager
    def environment(self) -> Iterator[dict[str, str]]:
        if self.method not in {"none", "http", "ssh"}:
            raise WikiError("invalid_git_auth", "Choose none, http or ssh authentication.")
        with tempfile.TemporaryDirectory(prefix="wiki-git-auth-") as tmp:
            root = Path(tmp)
            env: dict[str, str] = {}
            if self.method == "http" and self.token:
                helper = root / "askpass.sh"
                helper.write_text(
                    '#!/bin/sh\ncase "$1" in\n'
                    "[Uu]sername*|[Uu]ser*) printf '%s\\n' \"$SECOND_BRAIN_GIT_USERNAME\" ;;\n"
                    "*) printf '%s\\n' \"$SECOND_BRAIN_GIT_PASSWORD\" ;;\nesac\n",
                    encoding="utf-8",
                )
                helper.chmod(0o700)
                env.update(
                    {
                        "GIT_ASKPASS": str(helper),
                        "SECOND_BRAIN_GIT_USERNAME": self.username or "git",
                        "SECOND_BRAIN_GIT_PASSWORD": self.token,
                    }
                )
            if self.method == "ssh":
                key_path = self.ssh_key_path
                if self.ssh_key and not key_path:
                    key = root / "identity"
                    key.write_text(self.ssh_key, encoding="utf-8")
                    key.chmod(0o600)
                    key_path = str(key)
                if key_path and not Path(key_path).is_file():
                    raise WikiError("invalid_git_auth", "The configured SSH key is unavailable.")
                command = [
                    "ssh",
                    "-F",
                    os.devnull,
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "PasswordAuthentication=no",
                    "-o",
                    "KbdInteractiveAuthentication=no",
                    "-o",
                    "ForwardAgent=no",
                ]
                command += (
                    ["-i", key_path, "-o", "IdentitiesOnly=yes"]
                    if key_path
                    else ["-o", "IdentityFile=none"]
                )
                env["GIT_SSH_COMMAND"] = " ".join(shlex.quote(value) for value in command)
            yield env


def legacy_git_settings(target_override: str = "") -> tuple[str, str, GitCredentials, str | None]:
    """Resolve the same ENV/dotenv aliases and provider precedence as legacy Git."""
    from second_brain.core.config import Settings  # noqa: PLC0415

    settings = Settings()
    target = target_override or settings.vault_git_url
    method = settings.VAULT_GIT_AUTH_METHOD.strip().lower() or "auto"
    provider = settings.VAULT_GIT_PROVIDER.strip().lower() or "github"
    token = (
        settings.VAULT_GIT_HTTP_ACCESS_TOKEN
        or settings.VAULT_GIT_HTTP_TOKEN
        or (settings.VAULT_GITHUB_PAT if provider == "github" else "")
    )
    if method == "auto":
        method = "ssh" if target.startswith(("git@", "ssh://")) else "http" if token else "none"
    if method not in {"none", "http", "ssh"}:
        raise WikiError("invalid_git_auth", "Choose auto, none, http or ssh authentication.")
    username = settings.VAULT_GIT_HTTP_USERNAME.strip() or (
        "oauth2" if provider == "github" else "x-token-auth" if provider == "bitbucket" else "git"
    )
    return (
        target,
        settings.VAULT_GIT_BRANCH.strip(),
        GitCredentials(
            method=method,
            username=username,
            token=token,
            ssh_key_path=settings.VAULT_GIT_SSH_KEY_PATH.strip(),
            ssh_key=settings.VAULT_GIT_SSH_KEY,
        ),
        settings.VAULT_GIT_SSH_KNOWN_HOSTS_PATH.strip() or None,
    )
