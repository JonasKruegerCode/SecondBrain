"""Standalone, opt-in managed REST profile. Legacy deployment stays separate."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from second_brain.wiki.store import WikiError, WikiStore


def create_app(vault_path: str | Path, api_key: str = "") -> Starlette:
    store = WikiStore(vault_path)

    async def health(request: Request) -> Response:
        return JSONResponse({"status": "ok", "profile": "managed-wiki"})

    async def pages(request: Request) -> Response:
        rows = await run_in_threadpool(store.list_pages)
        return JSONResponse(
            {"pages": [{k: v for k, v in p.items() if k != "markdown"} for p in rows]}
        )

    async def page(request: Request) -> Response:
        page_id = request.path_params["page_id"]
        if request.method == "GET":
            result = await run_in_threadpool(store.get_page, page_id)
            if result is None:
                raise WikiError("not_found", "This page does not exist.")
            return JSONResponse(result)
        # No wildcard CORS. Same-origin browser writes protect proxy-authenticated deployments.
        origin = request.headers.get("origin")
        if origin and urlsplit(origin).netloc != request.headers.get("host"):
            return JSONResponse({"error": "origin_rejected"}, status_code=403)
        chunks = bytearray()
        async for chunk in request.stream():
            chunks.extend(chunk)
            if len(chunks) > 1_100_000:
                return JSONResponse({"error": "content_too_large"}, status_code=413)
        try:
            body = json.loads(chunks)
        except (ValueError, UnicodeDecodeError) as exc:
            raise WikiError("invalid_payload", "Provide a JSON request.") from exc
        if not isinstance(body, dict):
            raise WikiError("invalid_payload", "Provide a JSON object.")
        revision, request_id = body.get("base_revision"), body.get("request_id")
        if revision is not None and not isinstance(revision, str):
            raise WikiError("invalid_payload", "base_revision must be a string or null.")
        if not isinstance(request_id, str):
            raise WikiError("invalid_payload", "request_id is required.")
        if "base_revision" not in body:
            raise WikiError("invalid_payload", "base_revision is required; use null to create.")
        if request.method == "DELETE":
            if not isinstance(revision, str):
                raise WikiError("invalid_payload", "Deletion requires the read revision.")
            result = await run_in_threadpool(store.delete_page, page_id, revision, request_id)
        else:
            markdown = body.get("markdown")
            if not isinstance(markdown, str):
                raise WikiError("invalid_payload", "markdown must be a string.")
            result = await run_in_threadpool(
                store.save_page, page_id, markdown, revision, request_id
            )
        return JSONResponse(result)

    async def search(request: Request) -> Response:
        query = request.query_params.get("q", "")[:500]
        rows = await run_in_threadpool(store.search, query)
        return JSONResponse(
            {
                "results": [{k: v for k, v in p.items() if k != "markdown"} for p in rows],
                "mode": "lexical",
            }
        )

    async def graph(request: Request) -> Response:
        return JSONResponse(await run_in_threadpool(store.graph))

    async def history(request: Request) -> Response:
        return JSONResponse(
            {"history": await run_in_threadpool(store.history, request.path_params["page_id"])}
        )

    async def wiki_error(request: Request, exc: Exception) -> Response:
        assert isinstance(exc, WikiError)
        status = {
            "not_found": 404,
            "revision_conflict": 409,
            "request_id_reused": 409,
            "busy": 503,
            "storage_unavailable": 503,
            "content_too_large": 413,
        }
        return JSONResponse(
            {"error": exc.code, "message": exc.message, **exc.details},
            status_code=status.get(exc.code, 400),
        )

    app = Starlette(
        routes=[
            Route("/api/wiki/health", health),
            Route("/api/wiki/pages", pages),
            Route("/api/wiki/search", search),
            Route("/api/wiki/graph", graph),
            Route("/api/wiki/pages/{page_id}/history", history),
            Route("/api/wiki/pages/{page_id}", page, methods=["GET", "POST", "DELETE"]),
        ],
        exception_handlers={WikiError: wiki_error},
    )
    app.state.wiki_store = store

    async def privacy(request: Request, call_next: Any) -> Response:
        if api_key and not secrets.compare_digest(
            request.headers.get("authorization", ""), f"Bearer {api_key}"
        ):
            return JSONResponse(
                {"error": "unauthorized"}, status_code=401, headers={"Cache-Control": "no-store"}
            )
        response: Response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    app.add_middleware(BaseHTTPMiddleware, dispatch=privacy)
    return app


def app_factory() -> Starlette:
    path = os.environ.get("SECOND_BRAIN_WIKI_VAULT")
    if not path:
        raise RuntimeError("Set SECOND_BRAIN_WIKI_VAULT to an isolated managed vault directory.")
    return create_app(path, os.environ.get("SECOND_BRAIN_WIKI_API_KEY", ""))
