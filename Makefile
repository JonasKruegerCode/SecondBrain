# SecondBrain Dev Makefile
# Prerequisites: poetry install (backend), npm install (frontend), .env in repo root

# Stop the prod backend + worker containers to free ports 8000/3000.
BACKEND_CONTAINER ?= brain-backend-1
WORKER_CONTAINER  ?= brain-worker-1

dev-start-infra:
	docker stop $(BACKEND_CONTAINER) $(WORKER_CONTAINER) 2>/dev/null || true

# Start infrastructure from scratch (when the full stack is not running at all)
infra:
	docker compose up redis neo4j qdrant jaeger -d

# Start everything with auto-reload: API + MCP + Vite HMR
dev:
	cd backend && poetry run honcho start --procfile ../Procfile

# Backend only (no frontend)
dev-backend:
	cd backend && poetry run honcho start api mcp --procfile ../Procfile

# Return to prod: restart backend + worker containers
prod:
	docker start $(BACKEND_CONTAINER) $(WORKER_CONTAINER)

# Tests
test:
	cd backend && poetry run pytest tests/ --ignore=tests/integration --ignore=tests/test_git_sync.py -q

lint:
	cd backend && poetry run ruff check src/ tests/ benchmark/
