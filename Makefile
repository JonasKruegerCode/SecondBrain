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

# Run all checks: backend lint + types + tests + frontend types + build
check:
	cd backend && poetry run ruff check src/ tests/ benchmark/
	cd backend && poetry run mypy src/ tests/
	cd backend && poetry run pytest tests/ --ignore=tests/integration --ignore=tests/test_git_sync.py -q
	cd frontend && npx tsc --noEmit
	cd frontend && npm run build

# Individual targets
lint:
	cd backend && poetry run ruff check src/ tests/ benchmark/

typecheck:
	cd backend && poetry run mypy src/ tests/

test:
	cd backend && poetry run pytest tests/ --ignore=tests/integration --ignore=tests/test_git_sync.py -q

# Benchmark
benchmark-smoke:
	cd backend && poetry run python -m benchmark.run --input benchmark/smoke_test.md --run-id smoke_$(shell date +%Y%m%d_%H%M%S)

benchmark:
	cd backend && poetry run python -m benchmark.run --run-id run_$(shell date +%Y%m%d_%H%M%S) --verbose
