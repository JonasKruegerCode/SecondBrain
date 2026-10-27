"""Malformed JSON text must not reserve mutation receipts or alter storage."""

import hashlib
import json
from pathlib import Path

import pytest
from second_brain.wiki.api import create_app
from starlette.testclient import TestClient


def _file_hashes(root: Path) -> dict[str, str]:
    return {
        str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in root.rglob("*")
        if path.is_file()
    }


@pytest.mark.parametrize("mode", ["create", "update"])
@pytest.mark.parametrize("field", ["markdown", "base_revision", "request_id"])
@pytest.mark.parametrize("malformed", ["\ud800", "\udfff", "x\ud800y", "\udfff\ud800"])
def test_invalid_unicode_refusal_keeps_storage_and_allows_repaired_retry(
    tmp_path: Path, mode: str, field: str, malformed: str
) -> None:
    app = create_app(tmp_path)
    with TestClient(app) as client:
        saved = client.post(
            "/api/wiki/pages/harbor",
            json={
                "markdown": "# Café 🌌\nSynthetic shore.",
                "base_revision": None,
                "request_id": "seed",
            },
        )
        assert saved.status_code == 200
        page_id = "harbor" if mode == "update" else "new-page"
        payload = {
            "markdown": "# Étoiles 🌌\nSynthetic Unicode.",
            "base_revision": saved.json()["revision"] if mode == "update" else None,
            "request_id": "repairable",
        }
        before = app.state.wiki_store.snapshot()
        before_files = _file_hashes(tmp_path)
        # Escape at the JSON wire boundary: HTTPX's ordinary JSON encoder would
        # reject these Python strings before the actual API sees the request.
        response = client.post(
            "/api/wiki/pages/" + page_id,
            content=json.dumps({**payload, field: malformed}).encode(),
            headers={"Content-Type": "application/json"},
        )
        assert response.status_code == 400
        assert response.json()["error"] == "invalid_payload"
        assert response.headers["cache-control"] == "no-store"
        assert app.state.wiki_store.snapshot() == before
        assert _file_hashes(tmp_path) == before_files

        # A refusal must not reserve this request identity or revision. Valid
        # accented and astral text must survive the repair and a later reopen.
        retry = client.post("/api/wiki/pages/" + page_id, json=payload)
        assert retry.status_code == 200
        after_retry = app.state.wiki_store.snapshot()
        duplicate = client.post("/api/wiki/pages/" + page_id, json=payload)
        assert duplicate.status_code == 200
        assert duplicate.json() == retry.json()
        assert app.state.wiki_store.snapshot() == after_retry
        assert client.get("/api/wiki/pages/" + page_id).json()["markdown"] == payload["markdown"]

    with TestClient(create_app(tmp_path)) as reopened:
        assert reopened.get("/api/wiki/pages/" + page_id).json()["markdown"] == payload["markdown"]
