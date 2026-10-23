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

Prerequisites are Linux or WSL, Python 3.12, Poetry 2.1.3, Git, Make, Node 20+, and
the locked backend/frontend dependencies. Run these commands from the repository
root; the subshells keep the terminal there:

```sh
git clone https://github.com/JonasKruegerCode/SecondBrain.git
cd SecondBrain
git switch secondbrain-2.0
(cd backend && poetry sync --no-interaction)
(cd frontend && npm ci)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
SECOND_BRAIN_WIKI_API_KEY= make demo PYTHON="$WIKI_PYTHON"
```

Open <http://127.0.0.1:5173>. The command creates or reopens an isolated
12-page fictional Lantern Bay vault under ignored `.demo/` storage and starts
the real API and frontend. It requires no remote Git, database, embedding model
or LLM key and never seeds an existing nonempty vault.

The default demo disables external model calls. Stop the running demo with Ctrl+C
before restarting it with deliberate paid OpenRouter access on the same ports:

```sh
SECOND_BRAIN_WIKI_API_KEY= OPENROUTER_API_KEY=... PYTHONPATH=backend/src "$WIKI_PYTHON" \
  scripts/run-wiki-demo.py --with-openrouter
```

Use `"$WIKI_PYTHON" scripts/run-wiki-demo.py --help` for custom vault options. See the
[demo tour](documentation/demo-start.md) and
[development guide](documentation/managed-wiki-development.md) for the complete
commands and verification boundary.

To rehearse the normal acceptance path in one command, use a fresh disposable
vault and the real local API/frontend:

```sh
(cd frontend && npx playwright install --with-deps chromium)
SECOND_BRAIN_WIKI_API_KEY= make acceptance PYTHON="$WIKI_PYTHON"
```

This waits for both services, runs the normal Chromium browser suites, stops them even
on failure, and writes ignored logs plus a small JSON evidence record under
`.demo/acceptance/`. It disables external model calls and never targets an
existing or personal vault. Real OpenRouter, container, HTTPS and physical-device
checks remain separate release gates.

To check the empty first-start path and persistence across an actual API/frontend
restart, run `SECOND_BRAIN_WIKI_API_KEY= make acceptance-first-start PYTHON="$WIKI_PYTHON"`.
It starts with zero pages, creates only fictional test content, exercises the
editor/navigation/graph, stops both services and starts them again on the same
owned vault. The second browser phase checks the saved start page, exact content
and revisions. Scripted transport delay/failure checks are separate from real
outage evidence. Success removes the temporary vault and browser-state files;
CI uploads only structural results, browser logs and synthetic screenshots.

For explicit local Git import, run
`SECOND_BRAIN_WIKI_API_KEY= make acceptance-import PYTHON="$WIKI_PYTHON"`. It prepares an empty
repository and the public atlas with two original commits, imports both through
the setup CLI, and checks real article links, search, history and galaxy views.
A browser edit and saved start page must survive an identical import retry and
an API/frontend restart. New first-start imports and template seeding must refuse
the populated vault; the source repository must remain unchanged. All inputs are
owned and disposable; this does not validate a private migration or remote clone.

When a real key is available, the separate paid-provider gate checks two
bounded turns, required page reads, visible sources, proportional answers and
the read-only vault boundary against the fictional fixture. It records only
structural evidence (never answers, prompts, credentials or page content):

```sh
OPENROUTER_API_KEY=... make acceptance-openrouter PYTHON="$WIKI_PYTHON"
```

This command deliberately requires both the key and an explicit paid-provider
flag supplied by the Make target. It does not replace browser, device or hosted
infrastructure acceptance.

## Choose a persistent first start

The managed wiki requires an explicit destination and supports empty, fictional
template, or local Git import. Use the prepared backend environment from above:

```sh
export PYTHONPATH="$PWD/backend/src"

"$WIKI_PYTHON" -m second_brain.wiki.setup --vault /srv/secondbrain/vault --mode empty
# or:
"$WIKI_PYTHON" -m second_brain.wiki.setup --vault /srv/secondbrain/vault --mode template
# or:
"$WIKI_PYTHON" -m second_brain.wiki.setup --vault /srv/secondbrain/vault --mode import \
  --source /absolute/path/to/local-git-clone --prefix path/to/wiki \
  --request-id first-import
```

No mode overwrites a populated wiki. Import validates and preserves the source
history without copying credentials or remote configuration. Full rules:
[first-start profiles](documentation/first-start.md) and
[controlled Git import](documentation/wiki-import.md).

## Run the managed services

### Native

From the repository root, select the same backend environment in each terminal.

```sh
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
export PYTHONPATH="$PWD/backend/src"
export SECOND_BRAIN_WIKI_VAULT=/srv/secondbrain/vault

# Wiki REST API for the web UI
"$WIKI_PYTHON" -m uvicorn second_brain.wiki.api:app_factory --factory \
  --host 127.0.0.1 --port 8000

# In another terminal: local stdio MCP
"$WIKI_PYTHON" -m second_brain.wiki.mcp
```

For Streamable HTTP MCP, use the explicit factory and a server-side Bearer key:

```sh
SECOND_BRAIN_WIKI_API_KEY=replace-with-a-secret \
"$WIKI_PYTHON" -m uvicorn second_brain.wiki.mcp:http_app_factory --factory \
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

This Compose start is empty by default. To choose fictional template or local Git
content directly in that named volume, follow the explicit
[container first-start commands](documentation/first-start.md#container-first-start)
before starting services. Native setup into a host directory does not seed the
container volume. Docker source builds need the complete reviewed checkout and
Docker/Compose, without a native Python/Poetry/Node installation. PR builds do not
publish branch images; use source builds unless exact reviewed image artifacts
are actually available, as described in the install/update guide.

The backend healthcheck is a read-only readiness probe of the local bare Git
authority. An empty vault is healthy; after publication, an unavailable object
store or unreadable current commit makes the backend unhealthy instead of
allowing the frontend to start against a false-positive `ok` response.

For a containerized reverse proxy on an existing `proxy-network`, attach only
the public-facing services with a local override:

```yaml
services:
  frontend:
    networks:
      default: {}
      proxy-network:
        aliases: [secondbrain-wiki-web]
  mcp:
    networks:
      default: {}
      proxy-network:
        aliases: [secondbrain-wiki-mcp]

networks:
  proxy-network:
    external: true
    name: proxy-network
```

Route the wiki host to `secondbrain-wiki-web:80` and the MCP host to
`secondbrain-wiki-mcp:3001`. Choose unique aliases for each installation on the
shared proxy network; generic service names can collide with other projects.
Keep the existing proxy password on the wiki host, configure HTTPS, and add the exact MCP
host/origin to `.env.wiki`; do not expose either upstream directly.

Disposable image build/start, HTTPS/auth, restart and independent-volume recovery
have separate [CI acceptance](documentation/managed-stack-acceptance.md). Inspect
the reviewed revision's actual run; this does not accept your production proxy,
private credentials, migration or off-host recovery.
Use [backup and restore](documentation/backup-restore.md) before migration.
For a stable project/volume identity, container backup, reviewed image/source
selection and controlled recovery, follow the [install/update procedure](documentation/install-update.md).

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
- [Current review handoff and release gates](documentation/review-handoff.md)

## Current limits

The branch has native backend, browser, large synthetic graph and recovery
evidence. It does **not** yet claim:

- a real OpenRouter multi-turn acceptance run
- hosted Neo4j/Qdrant/embedding-provider acceptance
- physical Android/iOS installation or production HTTPS/update verification
- production Compose operation or off-host disaster recovery
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

