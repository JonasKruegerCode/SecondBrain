import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from second_brain.wiki.demo import DemoSeedError
from second_brain.wiki.setup import setup_vault
from second_brain.wiki.store import WikiError, WikiStore


def source_repo(path: Path, *, populated: bool = True) -> Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    if populated:
        (path / "home.md").write_bytes(b"# Home\r\nA fictional harbor.\r\n")
        subprocess.run(["git", "-C", str(path), "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                str(path),
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@localhost",
                "commit",
                "-qm",
                "Synthetic source",
            ],
            check=True,
        )
    return path


def test_empty_persistence_and_populated_refusal(tmp_path: Path) -> None:
    path = tmp_path / "managed"
    assert setup_vault(path, "empty")["pages"] == 0
    assert setup_vault(path, "empty")["revision"] is None
    store = WikiStore(path)
    store.save_page("home", "# Home", None, "save")
    before = store._head()
    with pytest.raises(WikiError, match="already contains"):
        setup_vault(path, "empty")
    assert store._head() == before
    with pytest.raises(DemoSeedError, match="nonempty"):
        setup_vault(path, "template")
    assert store._head() == before


def test_template_repeat_preserves_edited_pages(tmp_path: Path) -> None:
    path = tmp_path / "managed"
    first = setup_vault(path, "template")
    assert first["pages"] == 12
    repeated = setup_vault(path, "template")
    assert repeated["revision"] == first["revision"]
    assert repeated["status"] == "unchanged"
    store = WikiStore(path)
    home = store.get_page("home")
    assert home
    saved = store.save_page("home", "# Edited home", home["revision"], "edit-home")
    with pytest.raises(DemoSeedError, match="changed"):
        setup_vault(path, "template")
    assert store.get_page("home") == {k: v for k, v in saved.items() if k in home}


@pytest.mark.parametrize("populated", [True, False])
def test_import_create_only_retry_source_and_later_content_preserved(
    tmp_path: Path, populated: bool
) -> None:
    source = source_repo(tmp_path / "source", populated=populated)
    path = tmp_path / "managed"
    result = setup_vault(path, "import", source=source)
    store = WikiStore(path)
    assert len(store.list_pages()) == int(populated)
    assert setup_vault(path, "import", source=source)["revision"] == result["revision"]
    store.save_page("later", "# Later", None, "later")
    head = store._head()
    # A retry does not republish its imported content over later work.
    retry = setup_vault(path, "import", source=source)
    assert retry["revision"] == result["revision"]
    assert retry["current_revision"] == head
    assert store._head() == head
    assert store.get_page("later")
    with pytest.raises(WikiError, match="wiki changed"):
        setup_vault(path, "import", source=source, request_id="different")
    if populated:
        assert store.get_page("home")["markdown"].encode() == (source / "home.md").read_bytes()  # type: ignore[index]


@pytest.mark.parametrize(
    "mode,options",
    [
        ("other", {}),
        ("empty", {"source": "unused"}),
        ("empty", {"template": "unused"}),
        ("empty", {"resume": True}),
        ("template", {"prefix": "unused"}),
        ("import", {}),
    ],
)
def test_invalid_choice_does_not_create_vault(
    tmp_path: Path, mode: str, options: dict[str, object]
) -> None:
    path = tmp_path / "managed"
    with pytest.raises(WikiError):
        setup_vault(path, mode, **options)  # type: ignore[arg-type]
    assert not path.exists()


def test_real_cli_no_provider_credentials_and_explicit_choice(tmp_path: Path) -> None:
    env = {
        "PATH": os.environ["PATH"],
        "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src"),
    }
    args = [sys.executable, "-m", "second_brain.wiki.setup", "--vault", str(tmp_path / "cli")]
    result = subprocess.run(args + ["--mode", "empty"], env=env, capture_output=True, check=True)
    assert json.loads(result.stdout)["mode"] == "empty"
    rejected = subprocess.run(args, env=env, capture_output=True, check=False)
    assert rejected.returncode != 0
