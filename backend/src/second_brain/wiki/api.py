"""Standalone, opt-in managed REST profile. Legacy deployment stays separate."""

from __future__ import annotations

import json
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from second_brain.wiki.delivery import DeliveryCoordinator
from second_brain.wiki.delivery_runtime import DeliveryWorker
from second_brain.wiki.indexes import IndexCoordinator
from second_brain.wiki.store import WikiError, WikiStore


def create_app(
    vault_path: str | Path,
    api_key: str = "",
    *,
    indexes: IndexCoordinator | None = None,
    close_indexes: bool = False,
    delivery: DeliveryCoordinator | None = None,
    automatic_delivery: bool = False,
) -> Starlette:
    store = WikiStore(vault_path)
    indexes = indexes or IndexCoordinator(store)
    if indexes.store.path != store.path:
        raise ValueError("Indexes must belong to the same managed vault.")

    delivery = delivery or DeliveryCoordinator(store, indexes)
    if delivery.store.path != store.path or delivery.indexes is not indexes:
        raise ValueError("Delivery must use the same managed vault and indexes.")
    worker = DeliveryWorker(delivery) if automatic_delivery else None

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
            result = await run_in_threadpool(delivery.delete_page, page_id, revision, request_id)
        else:
            markdown = body.get("markdown")
            if not isinstance(markdown, str):
                raise WikiError("invalid_payload", "markdown must be a string.")
            result = await run_in_threadpool(
                delivery.save_page, page_id, markdown, revision, request_id
            )
        if worker is not None:
            worker.notify()
        return JSONResponse(result)

    async def search(request: Request) -> Response:
        query = request.query_params.get("q", "")[:500]
        if request.query_params.get("mode") == "semantic":
            return JSONResponse(await run_in_threadpool(indexes.semantic_search, query))
        if request.query_params.get("mode") == "graph_rag":
            return JSONResponse(await run_in_threadpool(indexes.graph_search, query))
        if request.query_params.get("mode", "lexical") != "lexical":
            raise WikiError("invalid_payload", "mode must be lexical, semantic or graph_rag.")
        rows = await run_in_threadpool(store.search, query)
        return JSONResponse(
            {
                "results": [{k: v for k, v in p.items() if k != "markdown"} for p in rows],
                "mode": "lexical",
            }
        )

    async def graph(request: Request) -> Response:
        return JSONResponse(await run_in_threadpool(store.graph))

    async def resolve_links(request: Request) -> Response:
        targets = request.query_params.getlist("target")
        source = request.query_params.get("source", "")
        if len(targets) > 200 or any(len(target) > 500 for target in targets) or len(source) > 160:
            raise WikiError("invalid_payload", "Resolve at most 200 links of 500 characters each.")
        return JSONResponse(await run_in_threadpool(store.resolve_links, targets, source))

    async def index_status(request: Request) -> Response:
        return JSONResponse(await run_in_threadpool(indexes.status))

    async def delivery_status(request: Request) -> Response:
        return JSONResponse(await run_in_threadpool(worker.status if worker else delivery.status))

    async def neighbors(request: Request) -> Response:
        try:
            hops = int(request.query_params.get("hops", "1"))
        except ValueError as exc:
            raise WikiError("invalid_payload", "hops must be an integer.") from exc
        return JSONResponse(
            await run_in_threadpool(indexes.neighbors, [request.path_params["page_id"]], hops)
        )

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
            "index_pending": 503,
            "index_unavailable": 503,
        }
        return JSONResponse(
            {"error": exc.code, "message": exc.message, **exc.details},
            status_code=status.get(exc.code, 400),
        )

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        if worker is not None:
            worker.start()
        try:
            yield
        finally:
            if worker is not None:
                await run_in_threadpool(worker.stop)
            if close_indexes:
                indexes.close()

    app = Starlette(
        routes=[
            Route("/api/wiki/health", health),
            Route("/api/wiki/pages", pages),
            Route("/api/wiki/search", search),
            Route("/api/wiki/graph", graph),
            Route("/api/wiki/resolve-links", resolve_links),
            Route("/api/wiki/index-status", index_status),
            Route("/api/wiki/delivery-status", delivery_status),
            Route("/api/wiki/pages/{page_id}/neighbors", neighbors),
            Route("/api/wiki/pages/{page_id}/history", history),
            Route("/api/wiki/pages/{page_id}", page, methods=["GET", "POST", "DELETE"]),
        ],
        exception_handlers={WikiError: wiki_error},
        lifespan=lifespan,
    )
    app.state.wiki_store = store
    app.state.wiki_indexes = indexes
    app.state.wiki_delivery = delivery

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
    from second_brain.wiki.delivery_runtime import configured_delivery  # noqa: PLC0415
    from second_brain.wiki.index_config import configured_indexes  # noqa: PLC0415

    store = WikiStore(path)
    indexes = configured_indexes(store)
    try:
        delivery = configured_delivery(store, indexes)
    except Exception:
        indexes.close()
        raise
    return create_app(
        path,
        os.environ.get("SECOND_BRAIN_WIKI_API_KEY", ""),
        indexes=indexes,
        delivery=delivery,
        automatic_delivery=os.environ.get("SECOND_BRAIN_WIKI_DELIVERY", "1") != "0",
        close_indexes=True,
    )
