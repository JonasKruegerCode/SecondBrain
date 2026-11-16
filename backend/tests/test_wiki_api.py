from pathlib import Path

import pytest
from starlette.testclient import TestClient

from second_brain.llm.providers.openrouter.client import OpenRouterClient
from second_brain.wiki.api import create_app
from second_brain.wiki.chat import WikiChat
from second_brain.wiki.store import WikiStore


@pytest.mark.parametrize(
    "authorization", [b"Bearer \xff", b"Bearer \xc3\xa9", b"Bearer wrong", b""]
)
def test_invalid_auth_is_private_and_rejected_before_dispatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, authorization: bytes
) -> None:
    app = create_app(tmp_path, "synthetic-test-key")
    store = app.state.wiki_store
    saved = store.save_page("harbor", "# Harbor\nSynthetic text.", None, "seed")
    before = store.snapshot()

    def unexpected(*args: object, **kwargs: object) -> None:
        pytest.fail("An unauthorized request reached a content service.")

    monkeypatch.setattr(WikiStore, "get_page", unexpected)
    monkeypatch.setattr(WikiStore, "save_page", unexpected)
    monkeypatch.setattr(WikiStore, "delete_page", unexpected)
    monkeypatch.setattr(OpenRouterClient, "__init__", unexpected)
    monkeypatch.setattr(WikiChat, "answer", unexpected)
    with TestClient(app) as client:
        for method, path, body in (
            ("GET", "/api/wiki/pages/harbor", None),
            ("POST", "/api/wiki/pages/harbor", {
                "markdown": "# Unauthorized edit", "base_revision": saved["revision"],
                "request_id": "unauthorized-save",
            }),
            ("DELETE", "/api/wiki/pages/harbor", {
                "base_revision": saved["revision"], "request_id": "unauthorized-delete",
            }),
            ("POST", "/api/wiki/chat", {"messages": [{"role": "user", "content": "Hello"}]}),
        ):
            response = client.request(
                method, path, json=body, headers=[(b"authorization", authorization)]
            )
            assert response.status_code == 401
            assert response.json() == {"error": "unauthorized"}
            assert response.headers["cache-control"] == "no-store"
        assert client.get("/api/wiki/health", headers={
            "Authorization": "Bearer synthetic-test-key",
        }).status_code == 200
    assert store.snapshot() == before


@pytest.mark.parametrize("origin", [
    "http://[broken", "http://testserver:wrong", "http://testserver:65536",
    "http://testserver/path", "http://testserver?q=x", "http://testserver#x",
    "http://user@testserver", "http://testserver ", "ftp://testserver",
    "https://unrelated.example", "null", "", "\x00http://testserver", "\x7fhttp://testserver",
])
def test_invalid_origin_rejected_before_mutation_or_chat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, origin: str
) -> None:
    app = create_app(tmp_path, "synthetic-test-key")
    store = app.state.wiki_store
    saved = store.save_page("harbor", "# Harbor\nSynthetic text.", None, "seed")
    before = store.snapshot()

    def unexpected(*args: object, **kwargs: object) -> None:
        pytest.fail("A rejected origin reached a content service.")

    monkeypatch.setattr(WikiStore, "save_page", unexpected)
    monkeypatch.setattr(WikiStore, "delete_page", unexpected)
    monkeypatch.setattr(WikiStore, "get_page", unexpected)
    monkeypatch.setattr(OpenRouterClient, "__init__", unexpected)
    monkeypatch.setattr(WikiChat, "answer", unexpected)
    with TestClient(app) as client:
        for method, path, body in (
            ("POST", "/api/wiki/pages/harbor", {
                "markdown": "# Unwanted edit", "base_revision": saved["revision"],
                "request_id": "origin-save",
            }),
            ("DELETE", "/api/wiki/pages/harbor", {
                "base_revision": saved["revision"], "request_id": "origin-delete",
            }),
            ("POST", "/api/wiki/chat", {"messages": [{"role": "user", "content": "Hello"}]}),
        ):
            response = client.request(method, path, json=body, headers={
                "Authorization": "Bearer synthetic-test-key", "Origin": origin,
            })
            assert response.status_code == 403
            assert response.json() == {"error": "origin_rejected"}
            assert response.headers["cache-control"] == "no-store"
    assert store.snapshot() == before


@pytest.mark.parametrize("origin", [None, "http://testserver", "https://testserver"])
def test_same_authority_and_nonbrowser_mutations_remain_available(
    tmp_path: Path, origin: str | None
) -> None:
    headers = {"Authorization": "Bearer synthetic-test-key"}
    if origin is not None:
        headers["Origin"] = origin
    with TestClient(create_app(tmp_path, "synthetic-test-key")) as client:
        response = client.post("/api/wiki/pages/harbor", headers=headers, json={
            "markdown": "# Harbor\nSynthetic text.", "base_revision": None, "request_id": "save",
        })
        assert response.status_code == 200
        revision = response.json()["revision"]
        assert client.get("/api/wiki/pages/harbor", headers=headers).json()["revision"] == revision
        assert client.request("DELETE", "/api/wiki/pages/harbor", headers=headers, json={
            "base_revision": revision, "request_id": "delete",
        }).status_code == 200
        assert client.get("/api/wiki/pages/harbor", headers=headers).status_code == 404


def test_backlinks_authority_bounds_auth_and_private_cache(tmp_path: Path) -> None:
    headers = {"Authorization": "Bearer synthetic-test-key"}
    with TestClient(create_app(tmp_path, "synthetic-test-key")) as client:
        assert client.get("/api/wiki/pages/target/backlinks").status_code == 401
        for key, body in {
            "target": "# Target\n[[outgoing]]",
            "source": "# Source\n[[Target#Detail|Label]] [[target]]",
            "outgoing": "# Outgoing\nNo links.",
        }.items():
            assert client.post(
                f"/api/wiki/pages/{key}",
                json={"markdown": body, "base_revision": None, "request_id": key},
                headers=headers,
            ).status_code == 200
        response = client.get("/api/wiki/pages/target/backlinks", headers=headers)
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        result = response.json()
        assert result["total"] == 1
        assert result["truncated"] is False
        assert result["backlinks"][0]["id"] == "source"
        assert "markdown" not in result["backlinks"][0]
        target = client.get("/api/wiki/pages/target", headers=headers).json()
        assert result["target_revision"] == target["revision"]
        graph = client.get("/api/wiki/graph", headers=headers).json()
        assert result["revision"] == graph["revision"]
        for limit in ("bad", "0", "101", "1.5"):
            failure = client.get(
                "/api/wiki/pages/target/backlinks", params={"limit": limit}, headers=headers
            )
            assert failure.status_code == 400
            assert failure.json()["error"] == "invalid_payload"
            assert failure.headers["cache-control"] == "no-store"
        missing = client.get("/api/wiki/pages/missing/backlinks", headers=headers)
        assert missing.status_code == 404
        assert missing.headers["cache-control"] == "no-store"
        for valid_limit in (1, 100):
            assert client.get(
                "/api/wiki/pages/target/backlinks", params={"limit": valid_limit}, headers=headers
            ).status_code == 200


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
        search = client.get("/api/wiki/search?q=fictional").json()
        assert search["mode"] == "lexical"
        assert search["limit"] == 50
        assert search["truncated"] is False
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


def test_lexical_search_reports_its_result_ceiling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rows: list[dict[str, object]] = [
        {
            "id": f"page-{index:02d}",
            "title": f"Shared result {index:02d}",
            "revision": "synthetic-revision",
            "excerpt": "Synthetic result.",
            "markdown": "# Private response body",
        }
        for index in range(51)
    ]

    def search(self: WikiStore, query: str, *, limit: int = 50) -> list[dict[str, object]]:
        assert query == "shared"
        assert limit == 51
        return rows[:limit]

    monkeypatch.setattr(WikiStore, "search", search)
    with TestClient(create_app(tmp_path)) as client:
        response = client.get("/api/wiki/search?q=shared")

    assert response.status_code == 200
    assert response.json() == {
        "mode": "lexical",
        "limit": 50,
        "truncated": True,
        "results": [
            {key: value for key, value in row.items() if key != "markdown"}
            for row in rows[:50]
        ],
    }


def test_optional_access_key_protects_reads_and_writes(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path, "synthetic-test-key")) as client:
        assert client.get("/api/wiki/pages").status_code == 401
        response = client.get(
            "/api/wiki/pages", headers={"Authorization": "Bearer synthetic-test-key"}
        )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"


def test_health_checks_the_local_git_authority(tmp_path: Path) -> None:
    with TestClient(create_app(tmp_path)) as client:
        assert client.get("/api/wiki/health").json() == {
            "status": "ok",
            "profile": "managed-wiki",
        }
        response = client.post(
            "/api/wiki/pages/harbor",
            json={
                "markdown": "# Harbor\nA fictional example.",
                "base_revision": None,
                "request_id": "health-page",
            },
        )
        assert response.status_code == 200
        assert client.get("/api/wiki/health").status_code == 200

        (tmp_path / ".wiki.git" / "objects").rename(tmp_path / "unavailable-objects")
        failed = client.get("/api/wiki/health")
        assert failed.status_code == 503
        assert failed.headers["cache-control"] == "no-store"
        assert failed.json() == {
            "error": "storage_unavailable",
            "message": "Local Git operation failed.",
        }


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
