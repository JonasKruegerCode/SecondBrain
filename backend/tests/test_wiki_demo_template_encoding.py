"""Invalid template encoding is refused before any managed storage is changed."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from second_brain.wiki.demo import seed_vault
from second_brain.wiki.store import WikiStore


def snapshot(path: Path) -> dict[str, bytes]:
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob("*") if p.is_file()}


@pytest.mark.parametrize("module", ["demo", "setup"])
@pytest.mark.parametrize("completed", [False, True])
def test_template_encoding_cli_refuses_and_can_retry(
    tmp_path: Path, module: str, completed: bool
) -> None:
    template = tmp_path / "template"
    template.mkdir()
    (template / "a-good.md").write_text("# Fictional harbor\n", encoding="utf-8")
    page = template / "z-sky.md"
    markdown = "# Fictional sky\n\nÉtoiles and 星.\n"
    page.write_text(markdown, encoding="utf-8")
    vault = tmp_path / "vault"
    if completed:
        seed_vault(vault, template)
    before = snapshot(vault)
    page.write_bytes(b"# Fictional sky\n\xff\n")
    template_before = snapshot(template)
    root = Path(__file__).resolve().parents[2]
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

    def run() -> subprocess.CompletedProcess[bytes]:
        return subprocess.run(
            command,
            capture_output=True,
            check=False,
            timeout=10,
            env={"PATH": os.environ["PATH"], "PYTHONPATH": str(root / "backend" / "src")},
        )

    refused = run()
    assert refused.returncode == 1
    assert refused.stdout == b""
    assert b"Traceback" not in refused.stderr
    assert b"Template page must be UTF-8: z-sky.md" in refused.stderr
    assert snapshot(vault) == before
    assert vault.exists() == completed
    assert snapshot(template) == template_before

    page.write_text(markdown, encoding="utf-8")
    accepted = run()
    assert accepted.returncode == 0, accepted.stderr
    stored = WikiStore(vault).get_page("z-sky")
    assert stored is not None and stored["markdown"] == markdown
    if completed:
        assert snapshot(vault) == before
