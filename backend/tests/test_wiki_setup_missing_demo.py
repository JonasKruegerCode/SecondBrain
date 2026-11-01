"""First-start commands must not replace a demo's missing content authority."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from second_brain.wiki.demo import seed_vault
from second_brain.wiki.setup import setup_vault
from second_brain.wiki.store import WikiError, WikiStore


def storage_bytes(path: Path) -> dict[str, bytes | str | None]:
    result: dict[str, bytes | str | None] = {}
    for item in path.rglob("*"):
        key = str(item.relative_to(path))
        if item.is_symlink():
            result[key] = os.readlink(item)
        else:
            result[key] = item.read_bytes() if item.is_file() else None
    return result


def source_repo(path: Path) -> Path:
    path.mkdir()
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    (path / "imported.md").write_text("# Synthetic inlet\n", encoding="utf-8")
    subprocess.run(["git", "-C", str(path), "add", "."], check=True)
    subprocess.run(
        ["git", "-C", str(path), "-c", "user.name=Fixture",
         "-c", "user.email=fixture@localhost", "commit", "-qm", "Synthetic fixture"],
        check=True,
    )
    return path


class MissingDemoSetupTests(unittest.TestCase):
    def fixture(self, root: Path) -> tuple[Path, Path]:
        template = root / "template"
        template.mkdir()
        (template / "home.md").write_text("# Synthetic harbor\n", encoding="utf-8")
        vault = root / "vault"
        seed_vault(vault, template)
        return vault, template

    def test_empty_and_import_refuse_missing_or_unsafe_demo_history(self) -> None:
        for mode in ("empty", "import"):
            for kind in ("missing", "file", "symlink", "dangling-symlink"):
                with self.subTest(mode=mode, kind=kind), tempfile.TemporaryDirectory() as tmp:
                    root = Path(tmp)
                    vault, _ = self.fixture(root)
                    source = source_repo(root / "source")
                    repo = vault / ".wiki.git"
                    held = root / "held-original"
                    repo.rename(held)
                    if kind == "file":
                        repo.write_text("synthetic obstruction", encoding="utf-8")
                    elif kind == "symlink":
                        repo.symlink_to(held, target_is_directory=True)
                    elif kind == "dangling-symlink":
                        repo.symlink_to(root / "absent", target_is_directory=True)
                    before = storage_bytes(root)
                    with self.assertRaises(WikiError) as caught:
                        setup_vault(vault, mode, source=source if mode == "import" else None)
                    self.assertEqual(caught.exception.code, "storage_unavailable")
                    self.assertEqual(storage_bytes(root), before)

    def test_real_cli_refuses_without_creating_replacement(self) -> None:
        for mode in ("empty", "import"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                vault, _ = self.fixture(root)
                source = source_repo(root / "source")
                (vault / ".wiki.git").rename(root / "held-original")
                before = storage_bytes(root)
                args = [sys.executable, "-m", "second_brain.wiki.setup",
                        "--vault", str(vault), "--mode", mode]
                if mode == "import":
                    args += ["--source", str(source)]
                env = {**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")}
                result = subprocess.run(args, env=env, capture_output=True, check=False)
                self.assertEqual(result.returncode, 1)
                self.assertIn(b"Restore", result.stderr)
                self.assertEqual(result.stdout, b"")
                self.assertEqual(storage_bytes(root), before)

    def test_explicit_fresh_setup_and_template_retries_still_work(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            empty = root / "empty"
            self.assertEqual(setup_vault(empty, "empty")["pages"], 0)
            self.assertEqual(setup_vault(empty, "empty")["pages"], 0)
            source = source_repo(root / "source")
            imported = root / "imported"
            first = setup_vault(imported, "import", source=source)
            self.assertEqual(setup_vault(imported, "import", source=source)["revision"],
                             first["revision"])
            vault, template = self.fixture(root)
            self.assertEqual(setup_vault(vault, "template", template=template)["status"],
                             "unchanged")
            store = WikiStore(vault)
            original = store.snapshot()
            with self.assertRaises(WikiError):
                setup_vault(vault, "empty")
            self.assertEqual(store.snapshot(), original)


if __name__ == "__main__":
    unittest.main()
