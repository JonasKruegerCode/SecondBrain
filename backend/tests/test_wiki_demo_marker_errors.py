"""Corrupt resume markers fail through the public CLI without changing content."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from second_brain.wiki import demo


def damaged_marker(kind: str, marker: dict[str, object]) -> str:
    if kind == "nested":
        return "[" * 11_000 + "0" + "]" * 11_000
    marker["state"] = [] if kind == "list" else {}
    return json.dumps(marker)


def snapshot(vault: Path) -> dict[str, bytes]:
    return {str(p.relative_to(vault)): p.read_bytes() for p in vault.rglob("*") if p.is_file()}


@pytest.mark.parametrize("kind", ["nested", "list", "dict"])
@pytest.mark.parametrize("module", ["demo", "setup"])
@pytest.mark.parametrize("resume", [False, True])
def test_corrupt_marker_cli_refuses_without_traceback_or_changes(
    tmp_path: Path,
    kind: str,
    module: str,
    resume: bool,
) -> None:
    template = tmp_path / "template"
    template.mkdir()
    (template / "home.md").write_text("# Fictional home\n", encoding="utf-8")
    vault = tmp_path / "vault"
    demo.seed_vault(vault, template)
    path = vault / demo.MARKER
    marker = json.loads(path.read_text())
    path.write_text(damaged_marker(kind, marker), encoding="utf-8")
    before = snapshot(vault)
    command = [
        sys.executable,
        "-m",
        f"second_brain.wiki.{module}",
        "--vault",
        str(vault),
        "--template",
        str(template),
    ]
    if module == "setup":
        command += ["--mode", "template"]
    if resume:
        command.append("--resume")
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        command,
        capture_output=True,
        check=False,
        timeout=10,
        env={"PATH": os.environ["PATH"], "PYTHONPATH": str(root / "backend" / "src")},
    )
    assert result.returncode == 1
    assert result.stdout == b""
    assert "Traceback" not in result.stderr.decode()
    assert "no content was changed" in result.stderr.decode()
    assert snapshot(vault) == before


@pytest.mark.parametrize("kind", ["nested", "list", "dict"])
def test_locked_marker_reread_refuses_corruption(tmp_path: Path, kind: str) -> None:
    # The second read under the seeder lock must validate independently.
    marker = {"format": demo.FORMAT_VERSION, "fingerprint": "synthetic"}
    (tmp_path / demo.MARKER).write_text(damaged_marker(kind, marker), encoding="utf-8")
    before = snapshot(tmp_path)
    with pytest.raises(demo.DemoSeedError, match="no pages were changed"):
        demo._seed_locked(tmp_path, {}, "synthetic", resume=True)
    assert snapshot(tmp_path) == before
