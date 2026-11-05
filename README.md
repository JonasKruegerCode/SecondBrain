# SecondBrain

A self-hosted, agent-maintained personal wiki. Markdown and Git are the source of
truth. The web app and direct MCP tools read and edit the same revisioned pages.

## Install with Docker

Requires **Docker Engine with Compose v2**. No host Python, Poetry, Node, source
checkout, local build directory or external startup script is needed.

1. Download the Compose file and environment template into one directory:

   ```sh
   mkdir secondbrain && cd secondbrain
   curl -fLO https://raw.githubusercontent.com/JonasKruegerCode/SecondBrain/main/docker-compose.yml
   curl -fsSL https://raw.githubusercontent.com/JonasKruegerCode/SecondBrain/main/.env.example -o .env
   ```

2. Edit `.env`: replace the MCP secret, select any optional Git repository and
   model/index providers, and set the actual MCP proxy Host/Origin allowlists.
   A new instance works without Git, databases or a model key; it starts empty.
   A configured Git URL pulls the selected Markdown folder automatically. The
   default folder is `1_knowledge/wiki`; set `SECOND_BRAIN_WIKI_GIT_PREFIX=` for
   Markdown at the repository root.

3. Start the published images:

   ```sh
   docker compose pull
   docker compose up -d --wait
   ```

Open <http://127.0.0.1:8080>. HTTP MCP is at
<http://127.0.0.1:3001/mcp>. `WIKI_FRONTEND_PORT` and `WIKI_MCP_PORT` change host
ports; an existing `MCP_PORT` is the fallback. Both ports bind to loopback.
Put the frontend and its same-origin `/api/` behind your authenticated HTTPS
proxy for remote use. Configure the existing MCP proxy's upstream to its
published host port and forward its separate key. See [install/update](documentation/install-update.md)
for Docker-network proxy routing, retained-image recovery and existing volumes.

**Existing installations:** this version removes the old application and changes
the backend image's default command. Before updating `latest`, read the
[breaking-change notes](documentation/install-update.md#existing-installations-and-breaking-changes).
An image update does not replace your Compose file. Preserve the actual volume,
vault subdirectory, project identity, authentication and proxy routes.

## One current application

The standard stack has three services:

| Service | Runtime | Access |
| --- | --- | --- |
| `frontend` | Current Wiki-first app, Nginx and same-origin API proxy | loopback 8080 → container 80 |
| `backend` | Managed REST API and independent Git/index delivery loops | internal 8000 |
| `mcp` | Managed Streamable HTTP MCP, same store and retrieval services | loopback 3001 → container 3001 |

REST and MCP are separate processes of the same application. Only REST runs
background delivery. Content persists in the named `managed_wiki` volume.

- Revision-safe Markdown editor, direct URLs, Home preference, history and retries
- Fast snapshot-based navigation, backlinks and a galaxy of actual links/groups
- Lexical search and optional Neo4j/Qdrant retrieval with full-article chunking
- Automatic configured Git clone/pull/commit/push with visible conflicts/retry
- Read-only OpenRouter chat, sources, safe Markdown and locally deletable conversations
- MCP page/search/graph/group/history/status tools and `wiki://guidance`
- Online-first PWA without caching private content

The old UI, `second_brain.mcp_server`, ingestion/repair agent, Celery/Redis and
telemetry application have been removed. `remember`/`recall` and old non-wiki REST
routes are intentionally gone. Existing Git configuration and MCP key
compatibility remain in the current core; see [MCP/auth](documentation/managed-mcp.md).
Graph and vector providers remain supported. Configure reachable existing
endpoints, or use the optional [database services](documentation/install-update.md#optional-index-databases).
Missing model access or an index build does not block local wiki reads.

## Build from source

Clone the repository and copy `.env.example` to `.env`. Then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build --wait
```

This is the same application and store, built inside Docker. Local Python/Node
are needed only for [native development and the fictional demo](documentation/managed-wiki-development.md),
not for either Docker path. Do not mix mutable source tags with a controlled
image-only update.

## Verification and limits

[Acceptance documentation](documentation/managed-stack-acceptance.md) describes
real disposable image, restart, Git, HTTPS/auth, MCP and browser gates. The stack
runner also tests the standard image-only Compose from an empty directory with
candidate images and the env template. Inspect the reviewed commit's actual CI
results; candidate builds do not publish registry images before merge.

Synthetic fixtures and provider doubles are distinct from real model quality,
private-vault migration, your proxy and physical Android/PWA installation.
[Current rollout and compatibility notes](documentation/cleanup-installation.md)
record the removal boundary and evidence. No final 2.0 release is implied.

- [First start: empty, template, Git import](documentation/first-start.md)
- [Git delivery and conflicts](documentation/managed-delivery.md)
- [Indexes and semantic search](documentation/managed-indexes.md)
- [Backup/restore](documentation/backup-restore.md)
- [PWA privacy and updates](documentation/pwa.md)
- [Deferred feature wishes](documentation/feature-wishlist.md)
