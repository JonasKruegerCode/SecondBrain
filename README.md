# SecondBrain

**Your knowledge becomes your agent’s experience.**

Build on what you’ve decided, tried and learned, even years later. SecondBrain
is a self-hosted wiki for you and your AI agent with powerful search that
brings back the details you barely remember.

<!-- Screenshot: Galaxy view of a small curated wiki. Add a real product screenshot here. -->

## Why SecondBrain

A better model brings more intelligence, while real work brings experience.
SecondBrain preserves your decisions and their reasons, what you tried, what
worked and what you learned, so your agent can build on that experience across
conversations and projects as the models behind it improve.

You read, explore and edit in the web app, while your agent searches and
maintains the same pages through MCP. Search and links help it find the
relevant details as your wiki grows. An optional OpenRouter key enables
meaning-based search alongside keyword matches, helping retrieve pages even
when your question uses different words.

The knowledge stays in plain Markdown in Git, with real revision history and
a repository you can back up or move. You can read and correct what your agent
works from and keep using it with other compatible agents. Core reading,
editing, history and lexical search work without a model key.

## What you get

- **A real wiki, not a note dump.** Revision-safe Markdown editor, direct page
  URLs, page history, backlinks, wikilinks and a browser-local start page.
- **Galaxy view.** A map of the explicit links between pages, with optional
  frontmatter groups for curated constellations. It is a navigation aid, not a
  claim of semantic similarity.
- **Hybrid search.** Ranked lexical search works immediately. When a Qdrant
  vector index is ready, the default search ranks pages by combining lexical
  and semantic matches. The last compatible ready index stays searchable during
  updates; lexical fallback is needed only before a compatible index is ready.
  The API and MCP also expose explicit semantic and GraphRAG modes.
- **Read-only chat.** With an OpenRouter key configured, ask questions and get
  answers grounded in the pages the assistant actually read, with source links.
  Conversations stay in your browser and can be deleted there.
- **An MCP server for agents.** Streamable HTTP or stdio, 11 revision-aware tools
  for pages, search, graph, groups, history and status, plus a `wiki://guidance`
  resource. Agents can maintain the wiki without a separate memory service.
- **Git-backed storage and sync.** The authoritative store is a bare Git
  repository inside the managed volume. Optionally sync with a Git remote:
  startup import, incoming changes, and outgoing snapshots, with visible
  conflicts instead of force-pushes.
- **Import and export.** Import a clean local Git repository of Markdown pages
  with an optional folder prefix; export the current wiki as plain Markdown.
- **Installable PWA.** An online-first app with install and update notices. It
  deliberately does not cache private pages, chat or authorization responses.
- **Retrieval services included.** The default Compose stack starts Neo4j for
  graph retrieval and Qdrant for vectors, so the graph and (with an embedding
  key) semantic ranking work alongside lexical search out of the box. A missing
  key or a still-building index never blocks reads, edits, history or lexical
  search.
- **Portable backups.** Create and verify a backup of Git history, request
  receipts and local ledgers, then restore into a new vault.

## Quick start

One command installs the complete stack — web app, REST backend, MCP server,
Neo4j and Qdrant — with generated secrets:

```sh
curl -fsSL https://raw.githubusercontent.com/JonasKruegerCode/SecondBrain/main/install.sh | sh
```

The script downloads the Compose file and environment template into a
`secondbrain` directory, creates a random MCP key and Neo4j password, then pulls
and starts everything. Open <http://127.0.0.1:8080> when it finishes.

Requires **Docker Engine with Compose v2**. No host Python, Poetry, Node or source
checkout is needed.

Prefer to do it yourself?

```sh
mkdir secondbrain && cd secondbrain
curl -fLO https://raw.githubusercontent.com/JonasKruegerCode/SecondBrain/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/JonasKruegerCode/SecondBrain/main/.env.example -o .env
```

Set a long random `SECOND_BRAIN_WIKI_API_KEY` and `NEO4J_PASSWORD` in `.env` (for
example with `openssl rand -hex 32`), then start the published images:

```sh
docker compose pull
docker compose up -d --wait
```

### The OpenRouter key

An **OpenRouter API key** (set `OPENROUTER_API_KEY` in `.env`) enables two extra
features: semantic-search embeddings written into Qdrant, and the optional
read-only chat. Everything else works without it:

- Reading, editing, history, the Markdown link graph, Galaxy and lexical search.
- The MCP server for agents, Git-backed storage and sync, import/export and
  backups.
- The frontend, REST backend, MCP server, Neo4j and Qdrant all start and stay up.

Without a key, chat and semantic ranking simply stay off; add the key and
recreate the stack to turn them on. Indexes may still be building after the app
is already usable, and a pending index never blocks lexical search.

### Settings you may want

| Variable | Purpose |
| --- | --- |
| `OPENROUTER_API_KEY` | Enables semantic-search embeddings and read-only wiki chat |
| `VAULT_GIT_URL` | Git repository to import at startup and sync afterwards |
| `VAULT_GIT_BRANCH` | Branch to use; defaults to the remote's advertised HEAD |
| `SECOND_BRAIN_WIKI_GIT_PREFIX` | Markdown folder in the repository; defaults to `1_knowledge/wiki`, empty means the repository root |
| `SECOND_BRAIN_WIKI_VECTOR_INDEX`, `SECOND_BRAIN_WIKI_GRAPH_INDEX` | Set to `0` to disable the vector (paid embeddings) or graph index |
| `WIKI_FRONTEND_PORT`, `WIKI_MCP_PORT` | Host ports; default `8080` and `3001` |

A new instance starts empty; no Git repository or model key is required. Both
ports bind to loopback. The HTTP MCP endpoint is at
<http://127.0.0.1:3001/mcp>; connect with the Bearer key from `.env`.

For remote access, put the frontend and its same-origin `/api/` behind an
authenticated HTTPS reverse proxy (for example `https://your-domain.example`),
and configure `SECOND_BRAIN_WIKI_MCP_ALLOWED_HOSTS` and
`SECOND_BRAIN_WIKI_MCP_ALLOWED_ORIGINS` for the MCP host before exposing it.
See the [installation, update and recovery guide](documentation/install-update.md).

## Starting with content

- **Existing Git wiki:** on a new instance, set `VAULT_GIT_URL` and the matching
  `SECOND_BRAIN_WIKI_GIT_PREFIX` in `.env`, then start the stack. The selected
  Markdown folder is pulled automatically and kept in sync.
- **Local Git repository:** import a committed Markdown repository with an
  optional folder prefix. See [importing a wiki](documentation/wiki-import.md).
- **Empty or template start:** use the explicit first-start profiles for an empty
  wiki, the fictional demo atlas, or a reviewed import:
  [choose a first-start profile](documentation/first-start.md).
- **Plain Markdown copy:** export the current pages with the
  [Markdown exporter](documentation/wiki-export.md).

## Documentation

| I want to… | Read |
| --- | --- |
| Install, update or recover an instance | [Install, update and recover](documentation/install-update.md) |
| Sync with Git and handle conflicts | [Recoverable delivery](documentation/managed-delivery.md) |
| Enable semantic search or GraphRAG | [Indexes and retrieval](documentation/managed-indexes.md) |
| Connect an MCP client | [Managed Wiki MCP](documentation/managed-mcp.md) |
| Import or export Markdown | [Import](documentation/wiki-import.md) · [Export](documentation/wiki-export.md) |
| Back up or restore | [Backup and restore](documentation/backup-restore.md) |
| Install the PWA and understand its privacy limits | [PWA guide](documentation/pwa.md) |
| Develop, test or release SecondBrain | [DEVELOPMENT.md](DEVELOPMENT.md) |

## License

MIT. See [LICENSE](LICENSE).
