"""Broken local publication refs must never masquerade as an empty wiki."""

import subprocess
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from starlette.testclient import TestClient

from second_brain.wiki.api import create_app
from second_brain.wiki.setup import setup_vault
from second_brain.wiki.store import REF, WikiError, WikiStore


def files(path: Path) -> dict[str, bytes | None]:
    return {
        str(p.relative_to(path)): p.read_bytes() if p.is_file() else None
        for p in path.rglob("*")
    }


@pytest.mark.parametrize("kind", [
    "malformed", "empty", "dangling", "loop", "directory", "packed", "masked-packed",
])
def test_broken_refs_refuse_reads_setup_and_writes_without_changing_storage(
    tmp_path: Path, kind: str,
) -> None:
    store = WikiStore(tmp_path)
    store.save_page("home", "# Synthetic harbor\n", None, "seed")
    ref = store.repo / REF
    if kind in {"packed", "masked-packed"}:
        store._git("pack-refs", "--all", "--prune")
        assert not ref.exists()
    if kind == "packed":
        (store.repo / "packed-refs").write_text("invalid packed reference\n")
    elif kind == "directory":
        ref.unlink()
        ref.mkdir()
    else:
        ref.write_text({
            "empty": "",
            "dangling": "ref: refs/heads/missing\n",
            "loop": f"ref: {REF}\n",
        }.get(kind, "not-an-object-id\n"))
    app = create_app(tmp_path)
    before = files(tmp_path)
    operations: list[Callable[[], Any]] = [
        store.check_health, store.list_pages, store.snapshot,
        lambda: store.get_page("home"),
        lambda: setup_vault(tmp_path, "empty"),
        lambda: store.save_page("later", "# Synthetic later\n", None, "later"),
    ]
    for operation in operations:
        with pytest.raises(WikiError) as caught:
            operation()
        assert caught.value.code == "storage_unavailable"
    with TestClient(app) as client:
        for endpoint in ["health", "pages", "pages/home", "graph"]:
            response = client.get(f"/api/wiki/{endpoint}")
            assert response.status_code == 503
            assert response.json() == {
                "error": "storage_unavailable", "message": "Local Git operation failed.",
            }
            assert response.headers["cache-control"] == "no-store"
        response = client.post("/api/wiki/pages/later", json={
            "markdown": "# Synthetic later\n", "base_revision": None, "request_id": "later-api",
        })
        assert response.status_code == 503
        assert response.json()["error"] == "storage_unavailable"
    assert files(tmp_path) == before


def test_unborn_and_packed_refs_remain_readable_and_writable(tmp_path: Path) -> None:
    store = WikiStore(tmp_path)
    assert store._head() == ""
    store.check_health()
    assert store.list_pages() == []
    assert setup_vault(tmp_path, "empty")["status"] == "ready"
    saved = store.save_page("home", "# Synthetic harbor\n", None, "seed")
    head = store._head()
    store._git("pack-refs", "--all", "--prune")
    assert not (store.repo / REF).exists()
    assert store._head() == head
    store.check_health()
    assert store.get_page("home")["revision"] == saved["revision"]  # type: ignore[index]
    updated = store.save_page("home", "# Synthetic edited harbor\n", saved["revision"], "edit")
    assert updated["revision"] != saved["revision"]
    assert WikiStore(tmp_path).get_page("home")["markdown"] == updated["markdown"]  # type: ignore[index]


@pytest.mark.parametrize("returncode", [-15, 1, 129])
def test_abnormal_git_exit_cannot_report_an_unborn_wiki(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, returncode: int,
) -> None:
    store = WikiStore(tmp_path)
    original = store._git_result

    def failed_revision(*args: str, **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        if args == ("rev-parse", "--verify", REF):
            return subprocess.CompletedProcess(args, returncode, b"", b"synthetic failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(store, "_git_result", failed_revision)
    with pytest.raises(WikiError) as caught:
        store.check_health()
    assert caught.value.code == "storage_unavailable"


def test_inaccessible_ref_probe_cannot_report_an_unborn_wiki(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = WikiStore(tmp_path)
    original = Path.lstat

    def inaccessible(path: Path) -> Any:
        if path == store.repo / REF:
            raise PermissionError("synthetic permission failure")
        return original(path)

    monkeypatch.setattr(Path, "lstat", inaccessible)
    with pytest.raises(WikiError) as caught:
        store.check_health()
    assert caught.value.code == "storage_unavailable"
