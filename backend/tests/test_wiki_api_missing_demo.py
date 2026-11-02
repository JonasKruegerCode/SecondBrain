"""API startup must preserve the authority identified by a surviving demo marker."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from second_brain.wiki.api import app_factory, create_app
from second_brain.wiki.demo import MARKER, seed_vault
from second_brain.wiki.store import WikiError, WikiStore


def storage_bytes(path: Path) -> dict[str, bytes | str | None]:
    return {
        str(item.relative_to(path)): (
            os.readlink(item) if item.is_symlink()
            else item.read_bytes() if item.is_file() else None
        )
        for item in path.rglob("*")
    }


class MissingDemoApiTests(unittest.TestCase):
    def fixture(self, root: Path) -> Path:
        template = root / "template"
        template.mkdir()
        (template / "home.md").write_text("# Synthetic harbor\n", encoding="utf-8")
        vault = root / "vault"
        seed_vault(vault, template)
        return vault

    def test_both_entries_refuse_missing_or_unsafe_demo_history(self) -> None:
        for entry in ("direct", "factory"):
            for kind in ("missing", "file", "symlink", "dangling-symlink"):
                with self.subTest(entry=entry, kind=kind), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    vault = self.fixture(root)
                    repository = vault / ".wiki.git"
                    held = root / "held-original"
                    repository.rename(held)
                    if kind == "file":
                        repository.write_text("synthetic obstruction", encoding="utf-8")
                    elif kind == "symlink":
                        repository.symlink_to(held, target_is_directory=True)
                    elif kind == "dangling-symlink":
                        repository.symlink_to(root / "absent", target_is_directory=True)
                    before = storage_bytes(root)
                    with (
                        patch.dict(os.environ, {"SECOND_BRAIN_WIKI_VAULT": str(vault)}),
                        self.assertRaises(WikiError) as caught,
                    ):
                        create_app(vault) if entry == "direct" else app_factory()
                    self.assertEqual(caught.exception.code, "storage_unavailable")
                    self.assertEqual(storage_bytes(root), before)

    def test_dangling_marker_also_prevents_replacement(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vault = root / "vault"
            vault.mkdir()
            (vault / MARKER).symlink_to(root / "absent-marker")
            before = storage_bytes(root)
            with self.assertRaises(WikiError) as caught:
                create_app(vault)
            self.assertEqual(caught.exception.code, "storage_unavailable")
            self.assertEqual(storage_bytes(root), before)

    def test_uvicorn_factory_exits_without_creating_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vault = self.fixture(root)
            (vault / ".wiki.git").rename(root / "held-original")
            before = storage_bytes(root)
            env = {**os.environ, "SECOND_BRAIN_WIKI_VAULT": str(vault),
                   "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
            result = subprocess.run(
                [sys.executable, "-m", "uvicorn", "second_brain.wiki.api:app_factory",
                 "--factory", "--host", "127.0.0.1", "--port", "0"],
                env=env, capture_output=True, timeout=15, check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"Restore", result.stderr)
            self.assertEqual(storage_bytes(root), before)

    def test_fresh_empty_and_existing_demo_reopen_preserve_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            empty = root / "empty"
            self.assertEqual(create_app(empty).state.wiki_store.list_pages(), [])
            self.assertEqual(create_app(empty).state.wiki_store.list_pages(), [])
            vault = self.fixture(root)
            store = WikiStore(vault)
            original = store.get_page("home")
            assert original is not None
            saved = store.save_page("home", "# Edited harbor\n", original["revision"], "edit")
            snapshot = store.snapshot()
            for entry in ("direct", "factory"):
                with patch.dict(os.environ, {
                    "SECOND_BRAIN_WIKI_VAULT": str(vault), "SECOND_BRAIN_WIKI_DELIVERY": "0",
                    "SECOND_BRAIN_WIKI_GRAPH_INDEX": "0", "SECOND_BRAIN_WIKI_VECTOR_INDEX": "0",
                }):
                    app = create_app(vault) if entry == "direct" else app_factory()
                reopened = app.state.wiki_store
                self.assertEqual(reopened.snapshot(), snapshot)
                self.assertEqual(reopened.save_page(
                    "home", "# Edited harbor\n", original["revision"], "edit",
                ), saved)
                self.assertEqual(reopened.snapshot(), snapshot)


if __name__ == "__main__":
    unittest.main()
