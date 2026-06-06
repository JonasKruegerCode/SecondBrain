## Local Development

### Prerequisites

- Python 3.12+, [Poetry](https://python-poetry.org/)
- Node 20+, npm
- Docker Desktop (for infrastructure and integration tests)

### 1 — One-time installation

```bash
# Backend
cd backend && poetry install && cd ..

# Frontend
cd frontend && npm install && cd ..
```

### 2 — Environment variables

Create `.env` in the **repo root** (ignored by Git):

```env
OPENROUTER_API_KEY=sk-or-...

NEO4J_PASSWORD=secretpassword
VAULT_PATH=C:/Users/your-name/vault   # local path (created automatically)
VAULT_GITHUB_URL=                     # optional: https://github.com/your/vault.git
VAULT_GITHUB_PAT=                     # optional: GitHub PAT for vault sync

# Local infrastructure (Docker containers via docker compose up)
REDIS_URL=redis://localhost:6379/0
NEO4J_URI=bolt://localhost:7687
QDRANT_URL=http://localhost:6333
MCP_API_KEY=                          # empty = no auth locally
```

> **Important:** Use `localhost`, not `redis`/`neo4j`/`qdrant` — those are Docker-internal hostnames that are only resolvable within the Docker network.

Clone vault locally (one-time):
```bash
git clone git@github.com:your/vault.git ../vault
```

### 3 — Start infrastructure

```bash
docker compose up redis neo4j qdrant -d
```

### 4 — Start backend

```bash
cd backend
poetry run python -m second_brain.mcp_server
# API running at http://localhost:8000
# MCP server running at http://localhost:3000
```

### 5 — Start Celery worker (second terminal)

Without the worker, `remember` calls are accepted but never processed.

```bash
# Linux/Mac
cd backend
poetry run celery -A second_brain.core.celery_app worker --loglevel=info --pool=solo
```

```powershell
# Windows — prefork pool doesn't work, use --pool=solo
cd backend
poetry run celery -A second_brain.core.celery_app worker --pool=solo --loglevel=info
```

> `--beat` (automatic Git sync at 03:00) is not possible in the worker process on Windows. Not needed for local development.

### 6 — Start frontend (third terminal)

```bash
cd frontend
npm run dev
# → http://localhost:5173
```

Vite automatically proxies `/api/*` to `localhost:8000` — no CORS, no extra configuration needed.

---

## Tests & Quality Assurance

```bash
# All checks (lint + types + tests + frontend build)
bash check.sh

# Lint and type checks only (fast, no Docker required)
bash check.sh --no-tests
```

| Check | Tool | Description |
|-------|------|-------------|
| ruff | `poetry run ruff check` | Import order, style, unused vars |
| mypy | `poetry run mypy` | Static types (strict mode) |
| pytest | `poetry run pytest` | Unit tests; integration tests only with `@pytest.mark.integration` |
| tsc | `npx tsc --noEmit` | TypeScript types in frontend |
| vite build | `npm run build` | Production build of the frontend |

**Integration tests** spin up their own Docker containers via Testcontainers — no running stack needed:

```bash
cd backend && poetry run pytest tests/integration -m integration
```

*(Docker Desktop must be running)*

---
