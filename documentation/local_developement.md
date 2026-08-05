## Local Development

### Prerequisites

- Python 3.14+, [Poetry](https://python-poetry.org/)
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
# LLM provider: "openrouter" | "gcp"
LLM_PROVIDER=openrouter
DEFAULT_MODEL=deepseek/deepseek-v4-flash
EMBEDDING_MODEL=openai/text-embedding-3-small

# OpenRouter (LLM_PROVIDER=openrouter)
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_CHAT_PROVIDER=
OPENROUTER_EMBEDDING_PROVIDER=

# GCP / Google AI (LLM_PROVIDER=gcp)
# GCP_API_KEY=AIza...
# GCP_ENDPOINT_URL=https://generativelanguage.googleapis.com/v1beta/openai
# DEFAULT_MODEL=gemini-2.0-flash
# EMBEDDING_MODEL=text-embedding-004

NEO4J_PASSWORD=secretpassword
VAULT_PATH=C:/Users/your-name/vault   # local path (created automatically)

# Git vault sync: GitHub remains the backwards-compatible default
# Existing GitHub deployments can keep using only these settings:
VAULT_GITHUB_URL=https://github.com/your/vault.git
VAULT_GITHUB_PAT=                    # optional GitHub PAT

# Optional provider-neutral configuration (overrides VAULT_GITHUB_*):
# VAULT_GIT_PROVIDER=github           # github | bitbucket | other
# VAULT_GIT_URL=https://github.com/your/vault.git
# VAULT_GIT_BRANCH=                   # empty = remote default branch
# VAULT_GIT_AUTH_METHOD=auto          # auto | http | ssh | none
# VAULT_GIT_HTTP_USERNAME=oauth2
# VAULT_GIT_HTTP_ACCESS_TOKEN=        # never commit this value

# Bitbucket example:
# VAULT_GIT_PROVIDER=bitbucket
# VAULT_GIT_URL=https://bitbucket.org/your-workspace/vault.git
# VAULT_GIT_BRANCH=wiki
# VAULT_GIT_AUTH_METHOD=http
# VAULT_GIT_HTTP_USERNAME=x-token-auth
# VAULT_GIT_HTTP_ACCESS_TOKEN=

# SSH alternative:
# VAULT_GIT_URL=git@bitbucket.org:your-workspace/vault.git
# VAULT_GIT_AUTH_METHOD=ssh
# VAULT_GIT_SSH_KEY_PATH=C:/secrets/bitbucket_ed25519
# VAULT_GIT_SSH_KNOWN_HOSTS_PATH=C:/secrets/known_hosts

# Local infrastructure (Docker containers)
REDIS_URL=redis://localhost:6379/0
NEO4J_URI=bolt://localhost:7687
QDRANT_URL=http://localhost:6333
MCP_API_KEY=                          # empty = no auth locally

OTEL_ENABLED=false                    # set to true to enable tracing
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317
```

> **Important:** Use `localhost`, not `redis`/`neo4j`/`qdrant` — those are Docker-internal hostnames only resolvable inside the Docker network.

> **Copied the production `.env`?** Change `VAULT_PATH=/vault` to a local path, e.g. `VAULT_PATH=C:/vault`. The `/vault` value refers to the Docker volume mount and does not exist on the host.

### 3 — Start infrastructure

All `make` commands must be run from the **repo root** (`~/Entwicklung/SecondBrain`).

**If the production stack is already running** (autostart on WSL boot), infrastructure is already up. Just stop the backend and worker containers to free the ports:

```bash
make dev-start-infra
# equivalent to: docker compose stop backend worker
```

**If the full stack is not running at all:**

```bash
make infra
# starts Redis, Neo4j, Qdrant, Jaeger from scratch
```

### 4 — Start dev server (one command, auto-reload)

```bash
make dev
```

This starts three processes in parallel with color-coded logs:

| Process | URL | Reload |
|---------|-----|--------|
| **api** | http://localhost:8000 | Auto-reload on Python file changes |
| **mcp** | http://localhost:3000 | Auto-reload on Python file changes |
| **frontend** | http://localhost:5173 | Vite HMR (instant) |

`Ctrl+C` stops all three.

Backend only (no frontend):
```bash
make dev-backend
```

> **Running alongside production Docker:** The prod instance uses ports `8000`/`3000`. To develop in parallel, add to your `.env`:
> ```env
> API_PORT=8001
> MCP_PORT=3001
> ```
> Dev runs on `:8001`/`:3001`, prod stays on `:8000`/`:3000`. Vite reads `API_PORT` automatically.

---

## Tests & Quality Assurance

```bash
make test   # unit tests
make lint   # ruff

# All checks (lint + types + tests + frontend build)
bash check.sh
```

| Check | Tool | Description |
|-------|------|-------------|
| ruff | `poetry run ruff check` | Import order, style, unused vars |
| mypy | `poetry run mypy` | Static types (strict mode) |
| pytest | `poetry run pytest` | Unit tests; integration tests need `@pytest.mark.integration` |
| tsc | `npx tsc --noEmit` | TypeScript types in frontend |
| vite build | `npm run build` | Production build of the frontend |

**Integration tests** spin up their own Docker containers via Testcontainers — no running stack needed:

```bash
cd backend && poetry run pytest tests/integration -m integration
```

*(Docker Desktop must be running)*

---

## Tracing

`recall`/`remember` go through several network hops (embeddings, Qdrant, Neo4j, LLM, vault I/O, Git). To see where time is actually going, traces are sent to [Jaeger](https://www.jaegertracing.io/) via OpenTelemetry.

1. Jaeger is already included in `make infra`
2. Set in `.env`: `OTEL_ENABLED=true` and `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`
3. Open the UI: http://localhost:16686 — pick a service (`secondbrain-backend`) and inspect a trace

Set `OTEL_ENABLED=false` to disable tracing entirely (no Jaeger needed).
