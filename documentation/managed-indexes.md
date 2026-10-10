# Managed snapshot indexes

The managed wiki's Git snapshot is authoritative. The optional Neo4j and Qdrant
adapters in `second_brain.wiki.index_adapters` receive injected clients; importing
this module does not load settings, choose an embedding provider, contact services,
or mutate Markdown. Callers explicitly configure the adapters and embedding model.

Both adapters implement `build(generation, snapshot)`. A snapshot contains its Git
`revision`, all full `pages`, and `graph` with `nodes` and `edges`. Page payloads
include `id`, `title`, `revision`, and `markdown`. Edges use `source`, `target`, and
an optional `rel` (the current graph's `type` is also accepted). These are full
snapshots, never incremental updates: a deleted or recreated page cannot inherit
an older generation's content or revision.

Every attempt needs a new generation: the persisted namespace UUID, an underscore,
and a fresh attempt UUID, represented with only letters, digits, and underscores.
A generation must never be reused, including after a failed or interrupted build.
Completed generations are immutable. The caller publishes a separate success
receipt only after `build` returns; it must never infer readiness from the presence
of a collection or graph marker. Receipts should identify the snapshot revision,
configuration identity, and exact generation independently for each backend.

## Neo4j

`Neo4jSnapshotAdapter(driver, database=None)` uses `ManagedWikiPage` and
`ManagedWikiGeneration`, never the legacy `WikiPage` label. A unique generation
constraint rejects generation reuse. Creating its marker, every page, and all
`LINKS_TO` relationships occurs in one `execute_write` transaction. Each page has
`generation`, `id`, `revision`, and `title`; each edge preserves its explicit
relation in `rel`. Failed transaction writes roll back together, and retrying the
transaction through the driver's retry mechanism remains safe.

`neighbors(generation, seeds, hops=1, limit=50)` traverses links in either direction,
returns distinct page IDs excluding seed IDs, and checks the generation of every
node along each path. Hops are restricted to 1–3 and limits to 1–1000. The managed
account needs permission to create the uniqueness constraint.

The adapter's transaction behavior and Cypher construction have been tested with
an explicit mocked transaction. A live Neo4j server has **not** been verified in
this validation; server version, privileges, constraint creation, transaction
rollback, and query execution still need an integration check in the deployment.

## Qdrant

`QdrantSnapshotAdapter(client, embedder, dimension)` uses a separate
`managed_wiki_<generation>` collection for each attempt, never `wiki_pages`.
The injected embedder's `embed(text)` method embeds full Markdown; vectors must
match the configured dimension and contain only finite values. All vectors are
validated before collection creation. Writes request `wait=True`, and a build
returns only after they complete. An empty snapshot creates an empty searchable
collection. `search(generation, query, limit=10)` returns `id`, page `revision`, and
`score`, with cosine similarity and a limit in 1–1000.

Use the same embedding model and dimension for indexing and querying a generation.
Changing an endpoint, model, dimension, or other indexing configuration requires a
new configuration identity and fresh generation. Tests use a real embedded
`QdrantClient(':memory:')` and deterministic synthetic embeddings; they do not claim
to validate a production embedding service or hosted Qdrant server.

## Recovery and retention

If a backend is unavailable or a build fails, preserve Git and its current content.
A failed Qdrant attempt can leave a partial collection, so create a fresh attempt
rather than repairing or publishing that collection. The coordinator stores a sanitized error receipt on failure,
replacing the prior receipt for that backend. Its retained backend generations are not served as
current. A ready receipt is published only after its exact snapshot finishes.

If receipt persistence fails after a successful build, the generation is an orphan:
recovery can start a fresh build, without changing Markdown or an existing
receipt. Independent graph and search receipts let one backend recover without
claiming the other is ready. The configuration fingerprint is shared across enabled backends:
changing graph or vector configuration invalidates both receipts until rebuilt.

Old and failed generations are retained. These adapters perform no garbage
collection and do not delete legacy indexes. Operators should account for storage
growth; a future cleanup process must protect every published generation and
coordinate with readers before removing anything.

## Enable and operate

Run the managed API or MCP profile with `SECOND_BRAIN_WIKI_VAULT` pointing to its
managed vault. The `configured_indexes(store)` factory enables adapters only when
these exact opt-in flags equal `1`:

| Backend | Opt-in flag | Required configuration |
| --- | --- | --- |
| Graph | `SECOND_BRAIN_WIKI_GRAPH_INDEX=1` | `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`; optional `NEO4J_DATABASE` |
| Vector | `SECOND_BRAIN_WIKI_VECTOR_INDEX=1` | `QDRANT_URL`, `SECOND_BRAIN_WIKI_VECTOR_DIMENSION`, existing `LLM_PROVIDER` and embedding-provider credentials/model settings; optional `QDRANT_API_KEY` |

The vector opt-in deliberately loads the existing embedding provider factory.
Without opt-in, ordinary managed wiki startup needs neither backend nor an
embedding provider. Keep the same configuration in API, MCP, and worker processes.

From the backend environment, build configured indexes once:

```sh
python -m second_brain.wiki.indexes
```

Force fresh builds even for an already current snapshot:

```sh
python -m second_brain.wiki.indexes --rebuild
```

There is no automatic scheduler. Repeat the worker explicitly after edits or
failures; it discovers the latest authoritative Git snapshot and skips ready
indexes unless `--rebuild` is supplied. Publication and index completion are
separate: Markdown writes succeed independently of indexing.

REST exposes `GET /api/wiki/index-status`,
`GET /api/wiki/search?q=QUERY&mode=semantic`, and
`GET /api/wiki/pages/PAGE_ID/neighbors?hops=1`.
MCP exposes `get_index_status()`, `search_wiki(query, mode="semantic")`, and
`get_neighbors(ids, hops=1, limit=50)`. Lexical search remains the default.
The additional `graph_rag` search mode (REST and MCP) combines up to ten vector
seeds with one-hop graph context, deduplicates pages and labels their retrieval
origin. It is non-generative retrieval, not a model answer or editorial process.
Semantic and graph reads require a ready receipt for the current Git revision and
configuration. Disabled, pending, error, or stale indexes do not provide current
results; provider outages return explicit unavailable errors.

Builds materialize the full snapshot and all embeddings in process memory.
Together with retaining old generations without garbage collection, this limits
practical scale until a separate streaming and retention design is implemented.

Validation on 2026-10-10 also started real Uvicorn REST and HTTP MCP listeners:
the MCP SDK and REST returned identical semantic results; a content mutation
made semantic reads pending while lexical search remained available; an explicit
worker run recovered current results. This used embedded Qdrant and synthetic
embeddings, not a live Neo4j server, hosted Qdrant, or external embedding model.
