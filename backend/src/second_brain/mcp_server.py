"""
Two separate ASGI apps in the same process:

  api_app  :8000  → REST endpoints (/api/remember, /api/recall, /api/graph)
  mcp_app  :3000  → MCP Streamable HTTP protocol (/mcp, protected by MCP_API_KEY)
"""

import asyncio
import re
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import uvicorn
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from opentelemetry.instrumentation.asgi import OpenTelemetryMiddleware
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from second_brain.core.config import settings
from second_brain.core.telemetry import init_tracing
from second_brain.git_sync import get_git_sync
from second_brain.llm.embedder import get_embedder
from second_brain.memory.graph import Neo4jStore
from second_brain.memory.hybrid_rag import HybridRAG
from second_brain.memory.vault import FileSystemVault
from second_brain.memory.vector import QdrantStore
from second_brain.worker.tasks import process_ingestion, reindex_after_pull

init_tracing("secondbrain-backend")

# ---------------------------------------------------------------------------
# Service-Factory
# ---------------------------------------------------------------------------

def _build_rag() -> tuple[HybridRAG, Neo4jStore]:
    vector_store = QdrantStore(settings.QDRANT_URL)
    graph_store = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
    vault_store = FileSystemVault(settings.VAULT_PATH)
    embedder = get_embedder()
    rag = HybridRAG(vector_store, graph_store, vault_store, embedder)
    return rag, graph_store


# ---------------------------------------------------------------------------
# VaultOps — deterministic, no LLM
# ---------------------------------------------------------------------------

class VaultOps:
    def __init__(self) -> None:
        self._wiki = Path(settings.VAULT_PATH) / "1_knowledge" / "wiki"

    def get_page(self, name: str) -> str:
        slug = re.sub(r"[^\w\-]", "-", name.lower()).strip("-")
        for f in self._wiki.rglob("*.md"):
            if f.stem.lower() in (name.lower(), slug):
                return f.read_text(encoding="utf-8")
        return f"Page '{name}' not found."


vault_ops = VaultOps()


# ---------------------------------------------------------------------------
# Shared tool dispatch logic (MCP + REST API)
# ---------------------------------------------------------------------------

async def _dispatch(name: str, args: dict[str, Any]) -> str:
    if name == "remember":
        task = process_ingestion.delay(args["text"], args.get("metadata") or {})
        return (
            f"Saved — Celery task `{task.id}` is running in the background.\n"
            f"Graph, vectors, and vault will be updated."
        )
    if name == "recall":
        rag, graph_store = _build_rag()
        try:
            return await rag.retrieve_context(args["query"], limit=args.get("limit", 5))
        finally:
            graph_store.close()
    return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# api_app — Port 8000 (REST API for the web frontend)
# ---------------------------------------------------------------------------

async def handle_api_remember(request: Request) -> JSONResponse:
    body = await request.json()
    result = await _dispatch("remember", body)
    return JSONResponse({"result": result})


async def handle_api_recall(request: Request) -> JSONResponse:
    body = await request.json()
    result = await _dispatch("recall", body)
    return JSONResponse({"result": result})


async def handle_api_graph(_request: Request) -> JSONResponse:
    graph_store = Neo4jStore(settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD)
    try:
        data = graph_store.get_all_graph()
    finally:
        graph_store.close()
    return JSONResponse(data)


async def handle_api_page(request: Request) -> JSONResponse:
    slug = request.path_params["slug"]
    content = vault_ops.get_page(slug)
    return JSONResponse({"content": content})


async def handle_api_ingestion_logs(_request: Request) -> JSONResponse:
    import json as _json  # noqa: PLC0415
    log_dir = Path(settings.VAULT_PATH) / "3_operations" / "ingestion-logs"
    if not log_dir.exists():
        return JSONResponse([])
    files = sorted(log_dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True)
    running: list[Any] = []
    completed: list[Any] = []
    for f in files:
        try:
            data = _json.loads(f.read_text(encoding="utf-8"))
            (running if data.get("status") == "running" else completed).append(data)
        except Exception:
            pass
    return JSONResponse(running + completed[:20])


@asynccontextmanager
async def _api_lifespan(_app: Starlette) -> AsyncGenerator[None, None]:
    get_git_sync().setup()
    get_embedder()
    reindex_after_pull.delay()
    yield


api_app = Starlette(
    lifespan=_api_lifespan,
    routes=[
        Route("/api/remember", endpoint=handle_api_remember, methods=["POST"]),
        Route("/api/recall", endpoint=handle_api_recall, methods=["POST"]),
        Route("/api/graph", endpoint=handle_api_graph),
        Route("/api/page/{slug}", endpoint=handle_api_page),
        Route("/api/ingestion-logs", endpoint=handle_api_ingestion_logs),
    ],
)


# ---------------------------------------------------------------------------
# mcp_app — Port 3000 (Streamable HTTP, protected by MCP_API_KEY)
# ---------------------------------------------------------------------------

class ApiKeyMiddleware:
    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] in ("http", "websocket"):
            headers = list(scope.get("headers", []))
            headers_dict = {k.lower(): v for k, v in headers}

            if settings.MCP_API_KEY:
                path = scope.get("path", "")
                public = (
                    path in ("/health", "/register", "/token")
                    or path.startswith("/.well-known")
                )
                if not public:
                    header_key = headers_dict.get(b"x-api-key", b"").decode()
                    auth_header = headers_dict.get(b"authorization", b"").decode()
                    bearer_key = auth_header[7:] if auth_header.lower().startswith("bearer ") else ""  # noqa: E501
                    query_string = scope.get("query_string", b"").decode()
                    query_key = parse_qs(query_string).get("api_key", [""])[0]
                    key = header_key or bearer_key or query_key
                    if key != settings.MCP_API_KEY:
                        response = Response("Unauthorized", status_code=401)
                        await response(scope, receive, send)
                        return

            # Ensure FastMCP's Accept-header check passes regardless of client
            accept = headers_dict.get(b"accept", b"").decode()
            if "application/json" not in accept:
                headers = [(k, v) for k, v in headers if k.lower() != b"accept"]
                headers.append((b"accept", b"application/json, text/event-stream"))
                scope = {**scope, "headers": headers}

        await self.app(scope, receive, send)


fmcp = FastMCP(
    "second-brain",
    json_response=True,
    stateless_http=True,
    transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
)


@fmcp.tool(description=(
    "Permanently saves text to the memory system. "
    "Celery worker runs the Wikipedia-agent pipeline: updates wiki, graph, vectors, and Git vault."
))
async def remember(text: str, metadata: dict[str, Any] | None = None) -> str:
    return await _dispatch("remember", {"text": text, "metadata": metadata or {}})


@fmcp.tool(description="Retrieves the best context for a query (HybridRAG: vector + graph + wiki + LLM).")  # noqa: E501
async def recall(query: str, limit: int = 5) -> str:
    return await _dispatch("recall", {"query": query, "limit": limit})



@fmcp.custom_route("/health", methods=["GET"])  # type: ignore[untyped-decorator]
async def handle_health(_request: Request) -> JSONResponse:
    vault_path = Path(settings.VAULT_PATH)
    wiki_path = vault_path / "1_knowledge" / "wiki"
    return JSONResponse({
        "status": "ok",
        "vault": str(vault_path),
        "wiki_pages": len(list(wiki_path.rglob("*.md"))) if wiki_path.exists() else 0,
        "llm_ready": bool(settings.OPENROUTER_API_KEY),
        "git_sync": bool(settings.VAULT_GITHUB_URL),
    })


def _mcp_base_url(request: Request) -> str:
    scheme = request.headers.get("x-forwarded-proto", "https")
    host = request.headers.get("host", "localhost")
    return f"{scheme}://{host}"


@fmcp.custom_route("/.well-known/oauth-protected-resource", methods=["GET"])  # type: ignore[untyped-decorator]
@fmcp.custom_route("/.well-known/oauth-protected-resource/mcp", methods=["GET"])  # type: ignore[untyped-decorator]
async def oauth_protected_resource(request: Request) -> JSONResponse:
    base = _mcp_base_url(request)
    return JSONResponse({"resource": f"{base}/", "authorization_servers": [base]})


@fmcp.custom_route("/.well-known/oauth-authorization-server", methods=["GET"])  # type: ignore[untyped-decorator]
async def oauth_authorization_server(request: Request) -> JSONResponse:
    base = _mcp_base_url(request)
    return JSONResponse({
        "issuer": base,
        "registration_endpoint": f"{base}/register",
        "token_endpoint": f"{base}/token",
        "grant_types_supported": ["client_credentials"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"],
    })


@fmcp.custom_route("/register", methods=["POST"])  # type: ignore[untyped-decorator]
async def oauth_register(_request: Request) -> JSONResponse:
    return JSONResponse({
        "client_id": "mcp-client",
        "client_secret": settings.MCP_API_KEY,
        "grant_types": ["client_credentials"],
        "token_endpoint_auth_method": "client_secret_post",
    }, status_code=201)


@fmcp.custom_route("/token", methods=["POST"])  # type: ignore[untyped-decorator]
async def oauth_token(request: Request) -> JSONResponse:
    body = await request.body()
    params = parse_qs(body.decode())
    grant_type = params.get("grant_type", [""])[0]
    client_secret = params.get("client_secret", [""])[0]
    if grant_type != "client_credentials":
        return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)
    if settings.MCP_API_KEY and client_secret != settings.MCP_API_KEY:
        return JSONResponse({"error": "invalid_client"}, status_code=401)
    return JSONResponse({
        "access_token": settings.MCP_API_KEY,
        "token_type": "bearer",
        "expires_in": 86400,
    })


mcp_app = ApiKeyMiddleware(fmcp.streamable_http_app())


# ---------------------------------------------------------------------------
# Entrypoint — both servers simultaneously
# ---------------------------------------------------------------------------

async def _main() -> None:
    api_cfg = uvicorn.Config(
        OpenTelemetryMiddleware(api_app), host="0.0.0.0", port=settings.API_PORT, log_level="info"
    )
    mcp_cfg = uvicorn.Config(
        OpenTelemetryMiddleware(mcp_app), host="0.0.0.0", port=settings.MCP_PORT, log_level="info"
    )
    await asyncio.gather(
        uvicorn.Server(api_cfg).serve(),
        uvicorn.Server(mcp_cfg).serve(),
    )


if __name__ == "__main__":
    asyncio.run(_main())
