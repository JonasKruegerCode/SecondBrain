"""Expected demo destination refusals are concise and preserve user files."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize("scale", [False, True])
@pytest.mark.parametrize("target_file", [False, True])
def test_demo_cli_refuses_existing_inputs_without_traceback_or_changes(
    tmp_path: Path, scale: bool, target_file: bool
) -> None:
    vault = tmp_path / "vault"
    if target_file:
        vault.write_text("Synthetic protected file.\n")
    else:
        vault.mkdir()
        (vault / "keep.md").write_text("# Synthetic protected article\n")
    before = {
        str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    }
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, str(root / "scripts" / "run-wiki-demo.py"), "--vault", str(vault)]
        + (["--scale-pages", "320"] if scale else []),
        env={"PATH": os.environ["PATH"], "PYTHONPATH": str(root / "backend" / "src")},
        capture_output=True,
        check=False,
        timeout=10,
    )
    assert result.returncode == 1
    assert result.stdout == b""
    assert b"Traceback" not in result.stderr
    assert result.stderr.startswith(b"Demo start refused: ")
    assert b"directory" in result.stderr
    assert vault.is_file() == target_file
    assert {
        str(p.relative_to(tmp_path)): p.read_bytes() for p in tmp_path.rglob("*") if p.is_file()
    } == before
