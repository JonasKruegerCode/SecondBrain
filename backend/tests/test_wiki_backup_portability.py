"""An archive alone must recover after the synthetic source is removed."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize("populated", [False, True], ids=["empty", "with-history"])
def test_relocated_archive_recovers_without_source(tmp_path: Path, populated: bool) -> None:
    source = tmp_path / "source"
    store = WikiStore(source)
    requests: list[dict[str, Any]] = []
    if populated:
        for page_id, markdown in [
            ("home", "# Synthetic recovery\n\n[[notes]]"),
            ("notes", "# Synthetic notes\n\nOriginal."),
        ]:
            payload: tuple[str, str, str | None, str] = (
                page_id,
                markdown,
                None,
                f"create-{page_id}",
            )
            requests.append(
                {"method": "save_page", "args": payload, "receipt": store.save_page(*payload)}
            )
        first = requests[-1]["receipt"]
        payload = ("notes", "# Synthetic notes\n\nLater.", first["revision"], "edit-notes")
        edited = store.save_page(*payload)
        requests.append({"method": "save_page", "args": payload, "receipt": edited})
        deleted = ("notes", edited["revision"], "delete-notes")
        requests.append(
            {"method": "delete_page", "args": deleted, "receipt": store.delete_page(*deleted)}
        )
    expected = {
        "snapshot": store.snapshot(),
        "graph": store.graph(),
        "history": {page: store.history(page) for page in ("home", "notes")},
    }
    indexes = IndexCoordinator(store)
    namespace = indexes.namespace
    DeliveryCoordinator(store, indexes)
    indexes.close()
    marker = b'{"fixture": "synthetic portable recovery"}\n'
    (source / ".second-brain-demo.json").write_bytes(marker)

    sender = tmp_path / "sender"
    receiver = tmp_path / "receiver with spaces ü"
    sender.mkdir()
    receiver.mkdir()
    pythonpath = str(Path(__file__).resolve().parents[1] / "src")
    env = {"PATH": os.environ["PATH"], "PYTHONPATH": pythonpath}

    def command(*arguments: str) -> dict[str, Any]:
        result = subprocess.run(
            [sys.executable, "-m", "second_brain.wiki.backup", *arguments],
            cwd=receiver,
            env=env,
            capture_output=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr.decode()
        assert result.stderr == b""
        decoded: dict[str, Any] = json.loads(result.stdout)
        return decoded

    archive = sender / "backup.tar.gz"
    assert (
        command("create", "--vault", str(source), "--archive", str(archive))["revision"]
        == expected["snapshot"]["revision"]
    )
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    transferred = receiver / "transferred.tar.gz"
    shutil.copyfile(archive, transferred)
    transferred.chmod(0o444)
    # Only this test's synthetic source and sending directory are removed.
    shutil.rmtree(source)
    shutil.rmtree(sender)
    assert not source.exists()
    restored_path = receiver / "restored?#%3F"
    result = command("restore", "--archive", str(transferred), "--vault", str(restored_path))
    assert result["revision"] == expected["snapshot"]["revision"]
    assert hashlib.sha256(transferred.read_bytes()).hexdigest() == digest
    restored = WikiStore(restored_path)
    assert restored.snapshot() == expected["snapshot"]
    assert restored.graph() == expected["graph"]
    assert {page: restored.history(page) for page in ("home", "notes")} == expected["history"]
    for request in requests:
        assert getattr(restored, request["method"])(*request["args"]) == request["receipt"]
    # Historical create/edit receipts must not resurrect the subsequently deleted page.
    assert restored.get_page("notes") is None
    assert restored.snapshot() == expected["snapshot"]
    assert restored.graph() == expected["graph"]
    assert {page: restored.history(page) for page in ("home", "notes")} == expected["history"]
    assert (restored_path / ".second-brain-demo.json").read_bytes() == marker
    restored_indexes = IndexCoordinator(restored)
    assert restored_indexes.namespace == namespace
    DeliveryCoordinator(restored, restored_indexes)
    restored_indexes.close()
    assert {path.name for path in receiver.iterdir()} == {"transferred.tar.gz", restored_path.name}
