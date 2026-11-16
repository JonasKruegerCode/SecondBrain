"""Exercise managed Make recipes without starting their services or runners."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

MANAGED_TARGETS = [
    ("demo", ["scripts/run-wiki-demo.py"], "backend/src"),
    ("demo-scale", ["scripts/run-wiki-demo.py", "--scale-pages", "320"], "backend/src"),
    ("acceptance", ["scripts/run-wiki-acceptance.py"], "backend/src"),
    ("acceptance-scale", ["scripts/run-wiki-acceptance.py", "--scale"], "backend/src"),
    ("acceptance-first-start", ["scripts/run-wiki-acceptance.py", "--first-start"], "backend/src"),
    ("acceptance-import", ["scripts/run-wiki-import-acceptance.py"], "backend/src"),
    (
        "acceptance-openrouter",
        ["scripts/run-wiki-openrouter-acceptance.py", "--confirm-paid-provider"],
        "backend/src",
    ),
    ("acceptance-stack", ["scripts/run-wiki-stack-acceptance.py"], None),
]


@pytest.mark.parametrize("target, expected_args, expected_pythonpath", MANAGED_TARGETS)
@pytest.mark.parametrize("interpreter_directory", ["venv", "venv with spaces"])
def test_managed_make_uses_selected_python_executable(
    tmp_path: Path,
    target: str,
    expected_args: list[str],
    expected_pythonpath: str | None,
    interpreter_directory: str,
) -> None:
    make = shutil.which("make")
    if make is None:
        pytest.skip("GNU Make is required to exercise the managed recipe shell boundary")

    # Copy the real recipes; a shim records their invocation instead of executing
    # a service, paid-provider acceptance runner, or Docker command.
    repository = Path(__file__).resolve().parents[2]
    shutil.copyfile(repository / "Makefile", tmp_path / "Makefile")
    interpreter = tmp_path / interpreter_directory / "bin" / "python"
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, pathlib, sys\n"
        "pathlib.Path(os.environ['MANAGED_MAKE_TEST_LOG']).write_text(\n"
        "    json.dumps({'args': sys.argv[1:],\n"
        "                'pythonpath': os.environ.get('PYTHONPATH')}),\n"
        "    encoding='utf-8',\n"
        ")\n",
        encoding="utf-8",
    )
    interpreter.chmod(0o755)
    invocation_log = tmp_path / "invocation.json"
    env = os.environ.copy()
    for variable in (
        "MAKEFLAGS", "GNUMAKEFLAGS", "MFLAGS", "MAKELEVEL", "MAKEOVERRIDES", "PYTHONPATH"
    ):
        env.pop(variable, None)
    env["MANAGED_MAKE_TEST_LOG"] = str(invocation_log)

    completed = subprocess.run(
        [make, "--no-print-directory", target, f"PYTHON={interpreter}"],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert invocation_log.is_file(), "Make did not invoke the selected Python executable"
    assert json.loads(invocation_log.read_text(encoding="utf-8")) == {
        "args": expected_args,
        "pythonpath": expected_pythonpath,
    }
