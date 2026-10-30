"""Reject an invalid complete template before creating a partial managed seed."""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from second_brain.wiki.demo import seed_vault
from second_brain.wiki.store import MAX_BYTES, WikiStore


def snapshot(path: Path) -> dict[str, bytes]:
    return {str(p.relative_to(path)): p.read_bytes() for p in path.rglob("*") if p.is_file()}


@pytest.mark.parametrize("kind", ["space", "leading-dot", "long-id", "large-page"])
@pytest.mark.parametrize("module", ["demo", "setup"])
@pytest.mark.parametrize("existing_empty", [False, True])
def test_invalid_template_does_not_leave_partial_seed(
    tmp_path: Path, kind: str, module: str, existing_empty: bool
) -> None:
    template = tmp_path / "template"
    template.mkdir()
    (template / "a-good.md").write_text("# Fictional harbor\n", encoding="utf-8")
    filename = {
        "space": "z invalid.md",
        "leading-dot": ".invalid.md",
        "long-id": "z" * 161 + ".md",
        "large-page": "z-large.md",
    }[kind]
    # Even a dot-prefixed name may sort before the good page; the byte-limit and
    # trailing invalid IDs also prove that earlier valid pages stay unpublished.
    invalid = template / filename
    invalid.write_text(
        "# Fictional sky\n" + ("星" * (MAX_BYTES // 3) if kind == "large-page" else ""),
        encoding="utf-8",
    )
    vault = tmp_path / "vault"
    if existing_empty:
        vault.mkdir()
    before = snapshot(vault)
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
    assert b"Traceback" not in refused.stderr
    assert refused.stdout == b""
    assert snapshot(vault) == before
    assert vault.exists() == existing_empty
    assert snapshot(template) == template_before
    assert b"Template" in refused.stderr

    invalid.unlink()
    (template / "z-sky.md").write_text("# Fictional sky\n", encoding="utf-8")
    retried = run()
    assert retried.returncode == 0, retried.stderr
    assert {p["id"] for p in WikiStore(vault).list_pages()} == {"a-good", "z-sky"}


def test_template_accepts_exact_store_byte_limit_and_valid_ids(tmp_path: Path) -> None:
    template = tmp_path / "template"
    template.mkdir()
    title = "# Fictional sky\n"
    remaining = MAX_BYTES - len(title.encode())
    markdown = title + "星" * (remaining // 3) + "x" * (remaining % 3)
    assert len(markdown) < MAX_BYTES and len(markdown.encode()) == MAX_BYTES
    page_id = "-étoile.v1"
    (template / f"{page_id}.md").write_text(markdown, encoding="utf-8")
    vault = tmp_path / "vault"
    assert seed_vault(vault, template)["pages"] == 1
    saved = WikiStore(vault).get_page(page_id)
    assert saved is not None and saved["markdown"] == markdown
