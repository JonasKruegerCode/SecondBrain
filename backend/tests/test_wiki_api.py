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


def test_link_resolution_matches_graph_and_keeps_ambiguity(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path)) as client:
        for key, body in {
            "source": "# Source\n[[Shared]] [[Unique title#Detail]] [[#Local]] [[gone]] [[exact]]",
            "a": "# Shared\nA",
            "b": "# Shared\nB",
            "unique": "# Unique title\n## Detail\nText",
            "exact": "# Other title\nID wins",
            "shadow": "# exact\nTitle loses to exact ID",
        }.items():
            assert (
                client.post(
                    f"/api/wiki/pages/{key}",
                    json={
                        "markdown": body,
                        "base_revision": None,
                        "request_id": key,
                    },
                ).status_code
                == 200
            )
        response = client.get(
            "/api/wiki/resolve-links",
            params=[
                ("source", "source"),
                ("target", "Shared"),
                ("target", "uNiQuE tItLe#Detail"),
                ("target", "#Local"),
                ("target", "gone"),
                ("target", "exact"),
            ],
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        data = response.json()
        rows = data["resolutions"]
        assert rows[0]["status"] == "ambiguous"
        assert [p["id"] for p in rows[0]["candidates"]] == ["a", "b"]
        assert rows[1]["candidates"] == [{"id": "unique", "title": "Unique title"}]
        assert rows[1]["fragment"] == "Detail"
        assert rows[2]["candidates"][0]["id"] == "source"
        assert rows[3]["status"] == "missing"
        assert rows[4]["candidates"][0]["id"] == "exact"
        graph = client.get("/api/wiki/graph").json()
        assert graph["revision"] == data["revision"]
        assert {e["target"] for e in graph["edges"] if e["source"] == "source"} == {
            "unique",
            "source",
            "exact",
        }
        assert (
            client.get("/api/wiki/resolve-links", params={"target": "x" * 501}).status_code == 400
        )
        assert (
            client.get("/api/wiki/resolve-links", params=[("target", "x")] * 201).status_code == 400
        )
        current = client.get("/api/wiki/pages/a").json()
        assert (
            client.request(
                "DELETE",
                "/api/wiki/pages/a",
                json={
                    "base_revision": current["revision"],
                    "request_id": "delete-a",
                },
            ).status_code
            == 200
        )
        updated = client.get("/api/wiki/resolve-links", params={"target": "Shared"}).json()
        assert updated["revision"] != data["revision"]
        assert updated["resolutions"][0]["status"] == "resolved"
        assert updated["resolutions"][0]["candidates"][0]["id"] == "b"
