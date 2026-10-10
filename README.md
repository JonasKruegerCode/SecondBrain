# SecondBrain

SecondBrain 2.0 is a self-hosted, agent-maintained personal wiki. Markdown and
Git are the source of truth; people read and edit the same revisioned pages
through a bright web interface, while agents use direct MCP tools for exact
reads, search, graph navigation and conflict-safe edits.

> The `secondbrain-2.0` branch is a tested development preview, not the final
> 2.0 release. Production migration and deployment still require the checks
> listed in [Current limits](#current-limits).

## What works now

- Wiki-first Home, safe Markdown articles, expected wikilinks and direct URLs
- revision-aware editor, local Git history and durable retry receipts
- lexical search plus optional Qdrant semantic search and Neo4j graph retrieval
- curated knowledge galaxy with real links, clusters, bridges and large-vault fallback
- bounded read-only OpenRouter chat with visible sources and browser-local conversations
- direct stdio or HTTP MCP with ten deterministic wiki tools and editing guidance
- empty, fictional-template or existing-Git first start
- explicit Git delivery, content export, and verified portable backup/restore
- installable online-first PWA without caching private wiki or chat data

The managed MCP intentionally has **no `remember` or `recall` tool**. Agents
read relevant pages, make an exact revision-guarded edit, and verify the result.
The earlier LLM-ingestion memory service remains available only as a separate
[legacy compatibility profile](documentation/legacy-memory-profile.md).
Never point managed and legacy writers at the same vault.

## Try the fictional demo

Prerequisites are Python 3.12, Git, Node 20+, and the locked backend/frontend
dependencies:

```sh
git clone https://github.com/JonasKruegerCode/SecondBrain.git
cd SecondBrain
git switch secondbrain-2.0
cd backend && poetry install && cd ..
cd frontend && npm ci && cd ..
cd backend
PYTHONPATH=src poetry run python ../scripts/run-wiki-demo.py
```

Open <http://127.0.0.1:5173>. The command creates or reopens an isolated
12-page fictional Lantern Bay vault under ignored `.demo/` storage and starts
the real API and frontend. It requires no remote Git, database, embedding model
or LLM key and never seeds an existing nonempty vault.

The default demo disables external model calls. To test paid OpenRouter chat
deliberately:

```sh
cd backend
OPENROUTER_API_KEY=... PYTHONPATH=src poetry run python \
  ../scripts/run-wiki-demo.py --with-openrouter
```

Use `python scripts/run-wiki-demo.py --help` for custom vault options. See the
[demo tour](documentation/demo-start.md) and
[development guide](documentation/managed-wiki-development.md) for the complete
commands and verification boundary.

## Choose a persistent first start

The managed wiki requires an explicit destination and supports empty, fictional
template, or local Git import:

```sh
export PYTHONPATH="$PWD/backend/src"

python -m second_brain.wiki.setup --vault /srv/secondbrain/vault --mode empty
# or:
python -m second_brain.wiki.setup --vault /srv/secondbrain/vault --mode template
# or:
python -m second_brain.wiki.setup --vault /srv/secondbrain/vault --mode import \
  --source /absolute/path/to/local-git-clone --prefix path/to/wiki \
  --request-id first-import
```

No mode overwrites a populated wiki. Import validates and preserves the source
history without copying credentials or remote configuration. Full rules:
[first-start profiles](documentation/first-start.md) and
[controlled Git import](documentation/wiki-import.md).

## Run the managed services

### Native

```sh
export PYTHONPATH="$PWD/backend/src"
export SECOND_BRAIN_WIKI_VAULT=/srv/secondbrain/vault

# Wiki REST API for the web UI
python -m uvicorn second_brain.wiki.api:app_factory --factory \
  --host 127.0.0.1 --port 8000

# In another terminal: local stdio MCP
python -m second_brain.wiki.mcp
```

For Streamable HTTP MCP, use the explicit factory and a server-side Bearer key:

```sh
SECOND_BRAIN_WIKI_API_KEY=replace-with-a-secret \
python -m uvicorn second_brain.wiki.mcp:http_app_factory --factory \
  --host 127.0.0.1 --port 3001
```

The [managed MCP guide](documentation/managed-mcp.md) documents Host/Origin
allowlists, reverse-proxy use, TLS and the editing contract.

### Docker Compose preview

Copy the synthetic configuration template, set a real MCP secret, then build:

```sh
cp .env.wiki.example .env.wiki
docker compose --env-file .env.wiki -f docker-compose.wiki.yml up -d --build
```

The web UI is bound to <http://127.0.0.1:8080> and HTTP MCP to
<http://127.0.0.1:3001/mcp>. Both share only the independent
`managed_wiki` volume. Put an authenticated HTTPS reverse proxy in front
before remote exposure. The API deliberately does not receive the MCP Bearer
key, so browser access remains same-origin and can retain the deployment's
existing proxy authentication.

For a containerized reverse proxy on an existing `proxy-network`, attach only
the public-facing services with a local override:

```yaml
services:
  frontend:
    networks: [default, proxy-network]
  mcp:
    networks: [default, proxy-network]

networks:
  proxy-network:
    external: true
    name: proxy-network
```

Route the wiki host to `frontend:80` and the MCP host to `mcp:3001`. Keep the
existing proxy password on the wiki host, configure HTTPS, and add the exact MCP
host/origin to `.env.wiki`; do not expose either upstream directly.

Container build/start is described but not yet accepted in the current
development environment because no Docker-compatible runtime was available.
Use [backup and restore](documentation/backup-restore.md) before migration.

## Managed MCP tools

| Tool | Purpose |
| --- | --- |
| `get_page` | Read exact Markdown and its revision |
| `list_pages` | List stable IDs, titles and metadata |
| `search_wiki` | Lexical, semantic or bounded GraphRAG retrieval |
| `get_graph` | Read explicit links from one content snapshot |
| `get_neighbors` | Expand explicit graph neighbors with limits |
| `save_page` | Save complete Markdown against the revision that was read |
| `delete_page` | Delete one reviewed revision |
| `get_history` | Read recent local Git history for a page |
| `get_index_status` | Inspect graph/vector progress independently |
| `get_delivery_status` | Inspect publication, index and cached Git delivery state |

Read the `wiki://guidance` MCP resource before editing. Lost responses are
retried with the same `request_id` and payload; revision conflicts require a
fresh read and deliberate reconciliation.

## Storage and optional services

| Layer | Required | Role |
| --- | --- | --- |
| Managed vault | Yes | Bare local Git repository containing Markdown snapshots and receipts |
| SQLite ledgers | Created locally | Durable index/delivery progress |
| Neo4j | Optional | Published graph snapshot |
| Qdrant + embedder | Optional | Semantic retrieval |
| Remote Git | Optional | Guarded snapshot delivery |
| OpenRouter | Optional | Read-only wiki chat |

Core page access, editing, history, lexical search and the Markdown graph work
without external providers. Configuration and failure semantics are documented
in [managed indexes](documentation/managed-indexes.md) and
[recoverable delivery](documentation/managed-delivery.md).

## Operations

- [Portable backup and restore](documentation/backup-restore.md)
- [Content-only Markdown export](documentation/wiki-export.md)
- [Explicit managed Git sync](documentation/managed-git-sync.md)
- [PWA privacy, installation and updates](documentation/pwa.md)

## Current limits

The branch has native backend, browser, large synthetic graph and recovery
evidence. It does **not** yet claim:

- a real OpenRouter multi-turn acceptance run
- hosted Neo4j/Qdrant/embedding-provider acceptance
- physical Android/iOS installation or production HTTPS/update verification
- verified Compose images, named-volume recovery or off-host disaster recovery
- completed production authentication, Git credential and legacy-vault migration

Do not treat the preview as a completed production cutover.

## Development

Run the repository checks after relevant changes:

```sh
cd backend
poetry run ruff check src/ tests/ benchmark/
poetry run mypy src/ tests/
poetry run pytest tests/ --ignore=tests/integration

cd ../frontend
npx tsc --noEmit
npm run build
```

Browser regression uses a disposable synthetic vault; see the
[development guide](documentation/managed-wiki-development.md). Public tests,
fixtures and screenshots must contain no private wiki content or credentials.

## License

MIT — see [LICENSE](LICENSE).
