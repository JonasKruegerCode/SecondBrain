import json
import os
import subprocess
import sys
from pathlib import Path

from second_brain.wiki.store import WikiStore


def command(vault: Path, remote: Path | str, *args: str) -> subprocess.CompletedProcess[bytes]:
    env = {
        "PATH": os.environ["PATH"],
        "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
    }
    return subprocess.run(
        [
            sys.executable,
            "-m",
            "second_brain.wiki.git_cli",
            "--vault",
            str(vault),
            "--remote",
            str(remote),
            "--branch",
            "wiki",
            *args,
        ],
        env=env,
        capture_output=True,
        check=False,
    )


def test_real_cli_push_inspect_pull_and_retry(tmp_path: Path) -> None:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
    source = WikiStore(tmp_path / "source")
    source.save_page("home", "# Home\nA synthetic harbor.", None, "fixture")
    args = ("push", "--base-revision", source._head(), "--remote-empty", "--request-id", "publish")
    pushed = command(source.path, remote, *args)
    assert pushed.returncode == 0, pushed.stderr
    published = json.loads(pushed.stdout)
    assert published["content_revision"] == source._head()
    assert json.loads(command(source.path, remote, *args).stdout) == published
    observed = command(source.path, remote, "inspect")
    assert (
        json.loads(observed.stdout)["observed_remote_revision"] == published["published_revision"]
    )
    target = tmp_path / "target"
    pulled = command(
        target,
        remote,
        "pull",
        "--managed-empty",
        "--expected-remote-revision",
        published["published_revision"],
        "--request-id",
        "import",
    )
    assert pulled.returncode == 0, pulled.stderr
    assert json.loads(pulled.stdout)["request_id"] == "import"
    page = WikiStore(target).get_page("home")
    assert page and page["markdown"] == "# Home\nA synthetic harbor."


def test_missing_explicit_guards_and_secret_url_refused(tmp_path: Path) -> None:
    remote = tmp_path / "remote.git"
    result = command(
        tmp_path / "vault", remote, "push", "--base-revision", "missing", "--request-id", "x"
    )
    assert result.returncode != 0
    assert not (tmp_path / "vault").exists()
    result = command(
        tmp_path / "vault",
        "https://fixture-user:synthetic-token@invalid.test/wiki",
        "inspect",
    )
    assert result.returncode != 0
    assert b"synthetic-token" not in result.stderr


def test_cli_explicit_trust_file_and_sanitized_missing_file(tmp_path: Path) -> None:
    remote = tmp_path / "remote.git"
    subprocess.run(["git", "init", "--bare", "-q", str(remote)], check=True)
    trust = tmp_path / "reviewed-known-hosts"
    trust.write_text("synthetic trust")
    result = command(tmp_path / "vault", remote, "--ssh-known-hosts", str(trust), "inspect")
    assert result.returncode == 0
    assert json.loads(result.stdout)["observed_remote_revision"] is None
    missing = tmp_path / "private-trust-location"
    denied = command(tmp_path / "vault", remote, "--ssh-known-hosts", str(missing), "inspect")
    assert denied.returncode == 1
    assert json.loads(denied.stderr)["error"] == "invalid_ssh_trust"
    assert str(missing).encode() not in denied.stderr
