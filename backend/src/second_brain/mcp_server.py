"""
Two separate ASGI apps in the same process:

  api_app  :8000  → REST endpoints (/api/remember, /api/recall, /api/graph)
  mcp_app  :3000  → MCP Streamable HTTP protocol (/mcp, protected by MCP_API_KEY)
"""

import asyncio
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

from second_brain.agent.operations import (
    AddClaim,
    CreatePage,
    DeleteClaim,
    DeletePage,
    EditClaim,
    EditSection,
    apply_operations,
)
from second_brain.core.config import settings
from second_brain.core.telemetry import init_tracing
from second_brain.git_sync import get_git_sync
from second_brain.llm.embedder import get_embedder
from second_brain.memory.graph import Neo4jStore
from second_brain.memory.hybrid_rag import HybridRAG
from second_brain.memory.indexing import (
    read_title,
    sync_vault,
    update_graph_and_vectors,
    wiki_base_path,
)
from second_brain.memory.vault import FileSystemVault
from second_brain.memory.vector import QdrantStore
from second_brain.worker.tasks import reindex_after_pull, run_ingestion_sync

init_tracing("secondbrain-backend")

# ---------------------------------------------------------------------------
# Service-Factory
# ---------------------------------------------------------------------------


def _build_rag() -> tuple[HybridRAG, Neo4jStore]:
    vector_store = QdrantStore(settings.QDRANT_URL)
    graph_store = Neo4jStore(
        settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD
    )
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

    def get_page(self, page_id: str) -> str:
        f = self._wiki / f"{page_id}.md"
        if f.is_file() and f.resolve().parent == self._wiki.resolve():
            return f.read_text(encoding="utf-8")
        return f"Page with id '{page_id}' not found."


vault_ops = VaultOps()


def _format_search_results(results: list[dict[str, Any]]) -> str:
    if not results:
        return "No matching wiki pages found."
    lines: list[str] = []
    for hit in results:
        lines.append(f"- **{hit['title']}** (id: {hit['id']})")
        for neighbor in hit.get("neighbors", []):
            lines.append(f"  - {neighbor.get('title')} (id: {neighbor.get('id')})")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Shared tool dispatch logic (MCP + REST API)
# ---------------------------------------------------------------------------


READ_TOOLS = ("recall", "get_RAG_response", "search_wiki", "get_page")

# Throttle so bursts (recall + get_page in a row) don't fetch on every call
READ_SYNC_INTERVAL_SECONDS = 30.0


async def _dispatch(name: str, args: dict[str, Any]) -> str:
    if name in READ_TOOLS:
        # Reads see the live state of all instances (pull + index refresh);
        # writes sync inside the Celery task itself.
        sync_vault(min_interval_seconds=READ_SYNC_INTERVAL_SECONDS)
    if name == "remember":
        return await run_ingestion_sync(args["text"], args.get("metadata") or {})
    if name == "get_RAG_response":
        rag, graph_store = _build_rag()
        try:
            return await rag.retrieve_context(args["query"], limit=args.get("limit", 5))
        finally:
            graph_store.close()
    if name == "recall":
        rag, graph_store = _build_rag()
        try:
            hits = await rag.search(args["query"], limit=3, hpos=1)
        finally:
            graph_store.close()
        if not hits:
            return "No matching wiki pages found."
        sections: list[str] = []
        for hit in hits:
            slug = str(hit["id"])
            title = str(hit.get("title", slug))
            content = vault_ops.get_page(slug)
            raw_neighbors = hit.get("neighbors", [])
            neighbors: list[dict[str, object]] = (
                raw_neighbors if isinstance(raw_neighbors, list) else []
            )
            block = f"## {title} (id: {slug})\n\n{content}"
            if neighbors:
                neighbor_lines = "\n".join(
                    f"- {n.get('title')} (id: {n.get('id')})"
                    for n in neighbors
                )
                block += f"\n\n**Neighbors:**\n{neighbor_lines}"
            sections.append(block)
        return "\n\n---\n\n".join(sections)
    if name == "search_wiki":
        rag, graph_store = _build_rag()
        try:
            results = await rag.search(
                args["query"], limit=args.get("limit", 15), hpos=args.get("hpos", 0)
            )
        finally:
            graph_store.close()
        return _format_search_results(results)
    if name == "get_page":
        return vault_ops.get_page(args["id"])
    return f"Unknown tool: {name}"


# ---------------------------------------------------------------------------
# Manual edit helpers — bypass LLM, go directly through apply + reindex
# ---------------------------------------------------------------------------


def _reindex_changed(changed: dict[str, str]) -> None:
    """Synchronously re-derive graph + vectors for changed pages."""
    wiki_base = wiki_base_path()
    pages = []
    for slug in changed:
        path = wiki_base / f"{slug}.md"
        if path.exists():
            pages.append((slug, read_title(path), path.read_text(encoding="utf-8")))
    if pages:
        update_graph_and_vectors(pages)


async def _apply_manual_ops(
    ops: list[Any], commit_msg: str
) -> dict[str, Any]:
    """Apply ops, reindex, push git. Returns result dict."""
    import asyncio as _asyncio  # noqa: PLC0415

    sync_vault()
    wiki_base = wiki_base_path()

    loop = _asyncio.get_event_loop()
    result = await loop.run_in_executor(None, apply_operations, ops, wiki_base)

    if result.changed or result.deleted:
        # Re-embed changed pages (skip deleted ones — they're gone)
        await loop.run_in_executor(None, _reindex_changed, result.changed)
        # Purge deleted slugs from Qdrant + Neo4j
        if result.deleted:
            from second_brain.memory.indexing import apply_index_diff  # noqa: PLC0415
            await loop.run_in_executor(
                None, apply_index_diff, [], list(result.deleted)
            )
        await loop.run_in_executor(
            None, lambda: get_git_sync().push(commit_msg)
        )

    return {
        "changed": list(result.changed.keys()),
        "created": sorted(result.created),
        "deleted": sorted(result.deleted),
        "skipped": result.skipped,
        "applied": result.applied,
    }


# ---------------------------------------------------------------------------
# api_app — Port 8000 (REST API for the web frontend)
# ---------------------------------------------------------------------------


async def handle_api_remember(request: Request) -> JSONResponse:
    body = await request.json()
    try:
        result = await _dispatch("remember", body)
        return JSONResponse({"result": result})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


async def handle_api_recall(request: Request) -> JSONResponse:
    body = await request.json()
    result = await _dispatch("recall", body)
    return JSONResponse({"result": result})


async def handle_api_rag(request: Request) -> JSONResponse:
    body = await request.json()
    result = await _dispatch("get_RAG_response", body)
    return JSONResponse({"result": result})


async def handle_api_graph(_request: Request) -> JSONResponse:
    graph_store = Neo4jStore(
        settings.NEO4J_URI, settings.NEO4J_USER, settings.NEO4J_PASSWORD
    )
    try:
        data = graph_store.get_all_graph()
    finally:
        graph_store.close()
    return JSONResponse(data)


async def handle_api_page(request: Request) -> JSONResponse:
    slug = request.path_params["slug"]
    content = vault_ops.get_page(slug)
    return JSONResponse({"content": content})


STALE_RUNNING_MINUTES = 30


def _mark_stale_running(data: dict[str, Any]) -> None:
    """Logs stuck in 'running' (crashed instance, never pushed completion)
    are displayed as failed instead of running forever."""
    if data.get("status") != "running":
        return
    try:
        from datetime import datetime, timedelta  # noqa: PLC0415

        started = datetime.fromisoformat(str(data.get("started")))
        if datetime.now() - started > timedelta(minutes=STALE_RUNNING_MINUTES):
            data["status"] = "failed"
            data["error"] = (
                f"stale — no completion after {STALE_RUNNING_MINUTES} min "
                "(instance crashed or offline)"
            )
    except Exception:
        pass


async def handle_api_ingestion_logs(_request: Request) -> JSONResponse:
    import json as _json  # noqa: PLC0415

    log_dir = Path(settings.VAULT_PATH) / "3_operations" / "ingestion-logs"
    if not log_dir.exists():
        return JSONResponse([])
    files = sorted(
        log_dir.glob("*.json"), key=lambda f: f.stat().st_mtime, reverse=True
    )
    running: list[Any] = []
    completed: list[Any] = []
    for f in files:
        try:
            data = _json.loads(f.read_text(encoding="utf-8"))
            _mark_stale_running(data)
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


async def handle_api_edit_page(request: Request) -> JSONResponse:
    body = await request.json()
    try:
        result = await edit_page(
            page_id=body["page_id"],
            op=body["op"],
            text=body.get("text", ""),
            section=body.get("section"),
            old_text=body.get("old_text", ""),
            new_text=body.get("new_text", ""),
        )
        return JSONResponse({"result": result})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


async def handle_api_delete_fact(request: Request) -> JSONResponse:
    body = await request.json()
    try:
        result = await delete_fact(page_id=body["page_id"], text=body["text"])
        return JSONResponse({"result": result})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


async def handle_api_delete_page(request: Request) -> JSONResponse:
    body = await request.json()
    try:
        result = await delete_wiki_page(page_id=body["page_id"], reason=body["reason"])
        return JSONResponse({"result": result})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


async def handle_api_create_page_manual(request: Request) -> JSONResponse:
    body = await request.json()
    try:
        result = await create_page_manual(title=body["title"], content=body["content"])
        return JSONResponse({"result": result})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


api_app = Starlette(
    lifespan=_api_lifespan,
    routes=[
        Route("/api/remember", endpoint=handle_api_remember, methods=["POST"]),
        Route("/api/recall", endpoint=handle_api_recall, methods=["POST"]),
        Route("/api/rag", endpoint=handle_api_rag, methods=["POST"]),
        Route("/api/graph", endpoint=handle_api_graph),
        Route("/api/page/{slug}", endpoint=handle_api_page),
        Route("/api/ingestion-logs", endpoint=handle_api_ingestion_logs),
        Route("/api/edit-page", endpoint=handle_api_edit_page, methods=["POST"]),
        Route("/api/delete-fact", endpoint=handle_api_delete_fact, methods=["POST"]),
        Route("/api/delete-page", endpoint=handle_api_delete_page, methods=["POST"]),
        Route(
            "/api/create-page",
            endpoint=handle_api_create_page_manual,
            methods=["POST"],
        ),
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
                public = path in ("/health", "/register", "/token") or path.startswith(
                    "/.well-known"
                )
                if not public:
                    header_key = headers_dict.get(b"x-api-key", b"").decode()
                    auth_header = headers_dict.get(b"authorization", b"").decode()
                    bearer_key = (
                        auth_header[7:]
                        if auth_header.lower().startswith("bearer ")
                        else ""
                    )  # noqa: E501
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


@fmcp.tool(
    description=(
        "Permanently saves text to the memory system. "
        "The edit_vault agent routes it via retrieval to the relevant wiki pages and "
        "applies minimal typed edits; graph, vectors, and Git vault are updated."
    )
)
async def remember(text: str, metadata: dict[str, Any] | None = None) -> str:
    return await _dispatch("remember", {"text": text, "metadata": metadata or {}})


@fmcp.tool(
    description=(
        "AI-free recall: returns the top 3 most relevant wiki pages with their full Markdown "
        "content, plus id and title of each page's direct graph neighbors. "
        "No LLM involved — fast and deterministic."
    )
)
async def recall(query: str) -> str:
    return await _dispatch("recall", {"query": query})


@fmcp.tool(
    description="Retrieves the best context for a query (HybridRAG: vector + graph + wiki + LLM)."
)
async def get_RAG_response(query: str, limit: int = 5) -> str:  # noqa: N802
    return await _dispatch("get_RAG_response", {"query": query, "limit": limit})


@fmcp.tool(
    description=(
        "Hybrid vector search over wiki pages — like recall, but returns raw hits "
        "(title + id) instead of an LLM-synthesized answer. "
        "hpos controls graph expansion per hit: 0 = hit only, 1 = include direct neighbors, "
        "2 = include neighbors of neighbors."
    )
)
async def search_wiki(query: str, limit: int = 15, hpos: int = 0) -> str:
    return await _dispatch(
        "search_wiki", {"query": query, "limit": limit, "hpos": hpos}
    )


@fmcp.tool(
    description=(
        "Retrieves the full Markdown content of a single wiki page by its id "
        "(as returned by search_wiki/recall)."
    )
)
async def get_page(id: str) -> str:  # noqa: A002
    return await _dispatch("get_page", {"id": id})


@fmcp.tool(
    description=(
        "Manually edit a wiki page: add, edit, or delete a specific claim, "
        "or replace a whole section. Bypasses LLM — you specify the exact operation. "
        "Graph and vector index are updated synchronously before returning. "
        "op must be one of: 'add_claim', 'edit_claim', 'delete_claim', 'edit_section'. "
        "For add_claim/edit_section provide 'text'. "
        "For edit_claim provide 'old_text' and 'new_text'. "
        "For delete_claim provide 'text' (exact sentence to remove). "
        "For edit_section provide 'section' (heading) and 'text' (new body). "
        "For add_claim 'section' is optional."
    )
)
async def edit_page(
    page_id: str,
    op: str,
    text: str = "",
    section: str | None = None,
    old_text: str = "",
    new_text: str = "",
) -> str:
    op_obj: Any
    if op == "add_claim":
        if not text:
            return "Error: 'text' is required for add_claim"
        op_obj = AddClaim(page=page_id, text=text, section=section)
    elif op == "edit_claim":
        if not old_text or not new_text:
            return "Error: 'old_text' and 'new_text' are required for edit_claim"
        op_obj = EditClaim(page=page_id, old_text=old_text, new_text=new_text)
    elif op == "delete_claim":
        if not text:
            return "Error: 'text' is required for delete_claim"
        op_obj = DeleteClaim(page=page_id, text=text)
    elif op == "edit_section":
        if not section or not text:
            return "Error: 'section' and 'text' are required for edit_section"
        op_obj = EditSection(page=page_id, section=section, text=text)
    else:
        return f"Error: unknown op '{op}'. Use: add_claim, edit_claim, delete_claim, edit_section"

    result = await _apply_manual_ops(
        [op_obj], f"manual edit_page: {op} on {page_id}"
    )
    if result["skipped"]:
        return f"Skipped: {'; '.join(result['skipped'])}"
    if result["applied"]:
        return f"Applied: {'; '.join(result['applied'])}. Reindexed: {result['changed']}"
    return "No changes made."


@fmcp.tool(
    description=(
        "Delete a specific fact/claim from a wiki page. "
        "The 'text' must match the exact sentence in the page. "
        "Graph and vector index are updated synchronously."
    )
)
async def delete_fact(page_id: str, text: str) -> str:
    result = await _apply_manual_ops(
        [DeleteClaim(page=page_id, text=text)],
        f"manual delete_fact: {page_id}",
    )
    if result["skipped"]:
        return f"Skipped: {'; '.join(result['skipped'])}"
    return f"Deleted claim from {page_id}. Reindexed."


@fmcp.tool(
    description=(
        "Delete an entire wiki page (hard-delete: file removed, Git is the audit trail). "
        "Removed from Qdrant and Neo4j immediately — no longer findable via search. "
    )
)
async def delete_wiki_page(page_id: str, reason: str) -> str:
    result = await _apply_manual_ops(
        [DeletePage(slug=page_id, reason=reason)],
        f"manual delete_page: {page_id}",
    )
    if result["skipped"]:
        return f"Skipped: {'; '.join(result['skipped'])}"
    return f"Page {page_id} deleted. Removed from search index."


@fmcp.tool(
    description=(
        "Manually create a new wiki page with given title and content. "
        "Bypasses LLM — you provide the exact Markdown content. "
        "Graph and vector index are updated synchronously before returning."
    )
)
async def create_page_manual(title: str, content: str) -> str:
    result = await _apply_manual_ops(
        [CreatePage(title=title, content=content)],
        f"manual create_page: {title}",
    )
    if result["skipped"]:
        return f"Skipped: {'; '.join(result['skipped'])}"
    if result["created"]:
        return (
            f"Created page '{title}' (id: {result['created'][0]}). "
            f"Graph and vectors updated."
        )
    return "No page created."


@fmcp.custom_route("/health", methods=["GET"])  # type: ignore[untyped-decorator]
async def handle_health(_request: Request) -> JSONResponse:
    vault_path = Path(settings.VAULT_PATH)
    wiki_path = vault_path / "1_knowledge" / "wiki"
    return JSONResponse(
        {
            "status": "ok",
            "vault": str(vault_path),
            "wiki_pages": (
                len(list(wiki_path.rglob("*.md"))) if wiki_path.exists() else 0
            ),
            "llm_ready": bool(settings.llm_api_key),
            "git_sync": bool(settings.VAULT_GITHUB_URL),
        }
    )


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
    return JSONResponse(
        {
            "issuer": base,
            "registration_endpoint": f"{base}/register",
            "token_endpoint": f"{base}/token",
            "grant_types_supported": ["client_credentials"],
            "token_endpoint_auth_methods_supported": [
                "client_secret_post",
                "client_secret_basic",
            ],
        }
    )


@fmcp.custom_route("/register", methods=["POST"])  # type: ignore[untyped-decorator]
async def oauth_register(_request: Request) -> JSONResponse:
    return JSONResponse(
        {
            "client_id": "mcp-client",
            "client_secret": settings.MCP_API_KEY,
            "grant_types": ["client_credentials"],
            "token_endpoint_auth_method": "client_secret_post",
        },
        status_code=201,
    )


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
    return JSONResponse(
        {
            "access_token": settings.MCP_API_KEY,
            "token_type": "bearer",
            "expires_in": 86400,
        }
    )


mcp_app = ApiKeyMiddleware(fmcp.streamable_http_app())


# ---------------------------------------------------------------------------
# Entrypoint — both servers simultaneously
# ---------------------------------------------------------------------------


async def _main() -> None:
    api_cfg = uvicorn.Config(
        OpenTelemetryMiddleware(api_app),
        host="0.0.0.0",
        port=settings.API_PORT,
        log_level="info",
    )
    mcp_cfg = uvicorn.Config(
        OpenTelemetryMiddleware(mcp_app),
        host="0.0.0.0",
        port=settings.MCP_PORT,
        log_level="info",
    )
    await asyncio.gather(
        uvicorn.Server(api_cfg).serve(),
        uvicorn.Server(mcp_cfg).serve(),
    )


if __name__ == "__main__":
    asyncio.run(_main())
