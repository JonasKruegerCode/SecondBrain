# Optional native development only; container installation needs no Honcho.
# Set SECOND_BRAIN_WIKI_VAULT to a dedicated development vault first.
api: uvicorn second_brain.wiki.api:app_factory --factory --host 127.0.0.1 --port ${API_PORT:-8000} --reload --reload-dir src
mcp: SECOND_BRAIN_WIKI_DELIVERY=0 uvicorn second_brain.wiki.mcp:http_app_factory --factory --host 127.0.0.1 --port ${MCP_PORT:-3001} --reload --reload-dir src
frontend: npm --prefix ../frontend run dev
