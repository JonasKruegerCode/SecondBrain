# honcho Procfile — run all dev processes with: make dev (from repo root)
# Prerequisite: infrastructure running (make infra or make dev-start-infra)
# honcho runs each command from the backend/ directory (set via make dev)

api:      uvicorn second_brain.mcp_server:api_app --host 0.0.0.0 --port ${API_PORT:-8000} --reload --reload-dir src
mcp:      uvicorn second_brain.mcp_server:mcp_app --host 0.0.0.0 --port ${MCP_PORT:-3000} --reload --reload-dir src
frontend: npm --prefix ../frontend run dev
