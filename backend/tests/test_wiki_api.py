from pathlib import Path

from starlette.testclient import TestClient

from second_brain.wiki.api import create_app


def test_read_write_conflict_and_private_cache_headers(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/wiki/pages").json() == {"pages": []}
        payload = {
            "markdown": "# Harbor\nA fictional example.",
            "base_revision": None,
            "request_id": "one",
        }
        saved = client.post("/api/wiki/pages/harbor", json=payload)
        assert saved.status_code == 200
        assert saved.headers["cache-control"] == "no-store"
        assert client.post("/api/wiki/pages/harbor", json=payload).json() == saved.json()
        stale = client.post("/api/wiki/pages/harbor", json={**payload, "request_id": "two"})
        assert stale.status_code == 409
        assert stale.json()["error"] == "revision_conflict"
        assert client.get("/api/wiki/pages/harbor").json()["markdown"] == payload["markdown"]
        assert client.get("/api/wiki/pages/unknown").status_code == 404
        assert client.get("/api/wiki/search?q=fictional").json()["mode"] == "lexical"
        assert len(client.get("/api/wiki/pages/harbor/history").json()["history"]) == 1
        assert client.post("/api/wiki/pages/harbor", json=[]).status_code == 400
        assert client.post("/api/wiki/pages/harbor", content="not json").status_code == 400
        assert client.post("/api/wiki/pages/harbor", json={"markdown": "x"}).status_code == 400
        assert (
            client.post(
                "/api/wiki/pages/harbor",
                json=payload,
                headers={"Origin": "https://unrelated.example"},
            ).status_code
            == 403
        )


def test_optional_access_key_protects_reads_and_writes(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path, "synthetic-test-key")) as client:
        assert client.get("/api/wiki/pages").status_code == 401
        response = client.get(
            "/api/wiki/pages", headers={"Authorization": "Bearer synthetic-test-key"}
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
