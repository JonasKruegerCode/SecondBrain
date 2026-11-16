"""Installer file privacy, using an isolated filesystem and no Docker daemon."""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


class InstallerEnvironmentPermissions(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory(prefix="secondbrain-installer-test-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.script = Path(__file__).resolve().parents[2] / "install.sh"
        binaries = self.root / "bin"
        binaries.mkdir()
        fixture = self.root / "downloads"
        fixture.mkdir()
        (fixture / "docker-compose.yml").write_text("services: {}\n", encoding="utf-8")
        (fixture / ".env.example").write_text(
            "SECOND_BRAIN_WIKI_API_KEY=placeholder\nNEO4J_PASSWORD=\nOPENROUTER_API_KEY=\n",
            encoding="utf-8",
        )
        commands = {
            "docker": '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INSTALL_TEST_CALLS"\n',
            "curl": (
                '#!/bin/sh\ncase "$2" in\n'
                '  */docker-compose.yml) cp "$INSTALL_TEST_SOURCE/docker-compose.yml" "$4";;\n'
                '  */.env.example) cp "$INSTALL_TEST_SOURCE/.env.example" "$4";;\n'
                '  *) exit 1;;\nesac\n'
            ),
        }
        for name, content in commands.items():
            command = binaries / name
            command.write_text(content, encoding="utf-8")
            command.chmod(0o755)
        self.calls = self.root / "docker-calls"
        self.environment = {
            **os.environ,
            "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
            "INSTALL_TEST_SOURCE": str(fixture),
            "INSTALL_TEST_CALLS": str(self.calls),
            "SECOND_BRAIN_DIR": str(self.root / "instance"),
            "SECOND_BRAIN_REF": "synthetic-ref",
            "OPENROUTER_API_KEY": "synthetic-provider-key",
        }

    def run_installer(self, directory: Path) -> None:
        # The calling shell supplies an ordinary permissive umask. The installer
        # must protect its own generated secrets independently of that caller.
        subprocess.run(
            ["sh", "-c", 'umask 022; exec sh "$1"', "installer-test", str(self.script)],
            cwd=directory,
            env=self.environment,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_fresh_install_keeps_generated_secrets_owner_only(self) -> None:
        self.run_installer(self.root)
        instance = self.root / "instance"
        env_file = instance / ".env"
        values = dict(line.split("=", 1) for line in env_file.read_text().splitlines())
        self.assertRegex(values["SECOND_BRAIN_WIKI_API_KEY"], r"^[0-9a-f]{64}$")
        self.assertRegex(values["NEO4J_PASSWORD"], r"^[0-9a-f]{64}$")
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
        self.assertFalse(list(instance.glob(".env.tmp.*")))
        self.assertEqual(
            self.calls.read_text().splitlines(),
            ["compose version", "compose pull", "compose up -d --wait"],
        )

    def test_rerun_preserves_existing_env_bytes_and_operator_permissions(self) -> None:
        instance = self.root / "existing"
        instance.mkdir()
        shutil.copyfile(
            self.root / "downloads" / "docker-compose.yml", instance / "docker-compose.yml"
        )
        env_file = instance / ".env"
        content = b"# Operator-owned configuration\nOPENROUTER_API_KEY=synthetic-existing\n"
        env_file.write_bytes(content)
        env_file.chmod(0o640)
        self.run_installer(instance)
        self.assertEqual(env_file.read_bytes(), content)
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o640)


if __name__ == "__main__":
    unittest.main()
