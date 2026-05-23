# SecondBrain

> A persistent MCP memory layer for AI agents. Store knowledge across sessions, retrieve it semantically, and connect any MCP-compatible agent — claude.ai, OpenClaw, or your own.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/python-3.12+-blue.svg)](https://www.python.org/)
[![Docker](https://img.shields.io/badge/docker-compose-blue.svg)](docker-compose.yml)

---

## What is SecondBrain?

AI agents are stateless by default — they forget everything when a session ends. SecondBrain solves this by providing a **persistent memory server** that any MCP-compatible agent can use to store and retrieve knowledge.

When an agent calls `remember("I just learned that...")`, SecondBrain:
1. Splits the input into independent topics
2. Searches existing knowledge for related pages
3. Uses an LLM planning agent (Wikipedia-style) to decide what to update or create
4. Writes free-form Markdown wiki pages to a Git-synced vault
5. Updates a knowledge graph (Neo4j) and semantic index (Qdrant)

When an agent calls `recall("what do I know about X?")`, SecondBrain runs HybridRAG — combining vector search, graph traversal, and LLM synthesis to return a contextual answer from the wiki.

## Features

- **MCP-native** — plug into claude.ai, OpenClaw, or any MCP client
- **Wikipedia-agent model** — planning + update agents write and revise wiki pages intelligently
- **HybridRAG** — vector search (Qdrant) + graph traversal (Neo4j) + Markdown vault
- **Markdown vault** — Obsidian-compatible, optionally Git-synced to any GitHub/GitLab/Gitea repo
- **Hourly review agent** — automatically cross-links related pages and resolves contradictions
- **Web UI** — knowledge graph visualizer + remember/recall interface
- **Self-hosted** — runs entirely on your own infrastructure

## Architecture

```
Agent (claude.ai / OpenClaw / custom)
  │  MCP protocol (port 3000)
  ▼
MCP Server ──remember──▶ Celery Worker ──▶ LLM planning agent
                                      ──▶ Wiki pages (Markdown vault)
                                      ──▶ Knowledge graph (Neo4j)
                                      ──▶ Semantic index (Qdrant)

MCP Server ──recall───▶ HybridRAG ──▶ Qdrant (vector search)
                                  ──▶ Neo4j (graph traversal)
                                  ──▶ Vault (Markdown load)
                                  ──▶ LLM synthesis ──▶ Answer
```

**Storage:**
| Layer | Technology | Purpose |
|-------|-----------|---------|
| Vault | Markdown + Git | Human-readable, Obsidian-compatible wiki |
| Graph | Neo4j | Link structure between pages (`[[wikilinks]]`) |
| Vectors | Qdrant | Semantic similarity search |
| Queue | Redis + Celery | Async ingestion, scheduled review |

---

## Quick Start

### Prerequisites

- Docker + Docker Compose
- An [OpenRouter](https://openrouter.ai/) API key (supports Claude, GPT-4, etc.)
- Optional: a private GitHub repo for vault sync

### 1 — Clone and configure

```bash
git clone https://github.com/JonasKruegerCode/SecondBrain.git
cd SecondBrain
cp .env.example .env
```

Edit `.env` — at minimum set your `OPENROUTER_API_KEY` and a `MCP_API_KEY` (any secret string).

### 2 — Start

```bash
docker compose up -d
```

That's it. Services:
- **Web UI**: `http://localhost` (via frontend container)
- **REST API**: `http://localhost:8000`
- **MCP endpoint**: `http://localhost:3000/mcp`

### 3 — Connect your agent

#### claude.ai

Go to **Settings → Integrations → Add MCP server**:

```
URL:     https://mcp.your-domain.com/mcp
API Key: your-secret-key   (set as Bearer token / MCP_API_KEY)
```

> For local testing without a public URL, use [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) to expose port 3000.

#### OpenClaw / custom MCP client

```json
{
  "mcpServers": {
    "secondbrain": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer your-secret-key"
      }
    }
  }
}
```

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `remember(text)` | Store knowledge — runs async in the background, returns a task ID |
| `recall(query, limit?)` | Retrieve context — HybridRAG + LLM synthesis |

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and adjust.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENROUTER_API_KEY` | *(required)* | API key for [OpenRouter](https://openrouter.ai/) |
| `MCP_API_KEY` | *(required)* | Secret key protecting the MCP endpoint |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | Comma-separated allowed Host headers — add your public MCP domain |
| `DEFAULT_MODEL` | `google/gemini-3.5-flash` | LLM for planning, writing, and synthesis |
| `EMBEDDING_MODEL` | `openai/text-embedding-3-small` | Embedding model for semantic search |
| `VAULT_PATH` | `/vault` | Filesystem path for the Markdown vault |
| `VAULT_GITHUB_URL` | *(optional)* | GitHub repo URL for vault sync |
| `VAULT_GITHUB_PAT` | *(optional)* | GitHub PAT with repo write access |
| `NEO4J_PASSWORD` | `secretpassword` | Neo4j database password |
| `REDIS_URL` | `redis://redis:6379/0` | Celery broker URL |
| `NEO4J_URI` | `bolt://neo4j:7687` | Neo4j connection URI |
| `QDRANT_URL` | `http://qdrant:6333` | Qdrant connection URL |

> **Localhost vs. Docker:** Use `localhost:*` for local dev. On a server with Docker Compose, use service names (`redis`, `neo4j`, `qdrant`) — they resolve inside the Docker network.

---

## Deployment (Self-Hosted Server)

You can deploy using the pre-built images — no fork or build step required. Just copy two files to your server.

### Server setup

```bash
# Copy only these two files to the server
scp docker-compose.yml .env user@your-server:/opt/secondbrain/

# On the server
cd /opt/secondbrain
docker compose pull
docker compose up -d
```

Pre-built images are published automatically from this repository:
- `ghcr.io/jonaskruegercode/secondbrain-frontend:latest`
- `ghcr.io/jonaskruegercode/secondbrain-backend:latest`

### Build locally instead

If you prefer to build from source (e.g. after making changes):

```bash
docker compose up -d --build
```

The `docker-compose.yml` includes `build:` directives pointing to `./frontend` and `./backend`, so this works out of the box.

### Updates

```bash
docker compose pull && docker compose up -d
```

### Nginx Proxy Manager (recommended reverse proxy)

| Domain | Forward to | Notes |
|--------|-----------|-------|
| `brain.your-domain.com` | `frontend:80` + location `/api` → `backend:8000` | Add Basic Auth |
| `mcp.your-domain.com` | `backend:3000` | Protected by `MCP_API_KEY` |

Add `mcp.your-domain.com` to `MCP_ALLOWED_HOSTS` in your `.env`.

Nginx Proxy Manager uses a shared Docker network to reach containers. Create it once and attach the services:

```bash
docker network create proxy-network
docker network connect proxy-network secondbrain-frontend-1
docker network connect proxy-network secondbrain-backend-1
```

---

## Local Development

See [documentation/local_developement.md](documentation/local_developement.md) for the full local dev setup with hot reload, test instructions, and quality checks.

---

## Contributing

Contributions are welcome. Here's what would make this project more production-ready as open source:

- **Alternative LLM providers** — support for direct OpenAI/Anthropic keys (not just OpenRouter)
- **Documentation** — usage examples, cookbook for common agent patterns
- **Git sync: any host** — currently only GitHub PAT auth is tested. Supporting GitLab, Gitea, and self-hosted instances would make the feature genuinely host-agnostic
- **Tests** — expand integration test coverage (`backend/tests/`)
- **CI** — add GitHub Actions workflow for `pytest` and `ruff`/`mypy` on PRs
- **Vault templates** — starter vault structures for different use cases

To contribute:
1. Fork the repo
2. Create a feature branch
3. Run `bash check.sh` to verify lint, types, and tests pass
4. Open a pull request

Please open an issue before starting work on a significant change.

---

## License

MIT — see [LICENSE](LICENSE).
