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

Unit tests cover transaction behavior and Cypher construction with an explicit
mocked transaction. The separate [disposable server acceptance](managed-index-acceptance.md)
also exercises real Neo4j with synthetic content. Neither establishes the
server version, account privileges, or operational behavior of your deployment;
verify that configuration separately.

## Qdrant

`QdrantSnapshotAdapter(client, embedder, dimension)` uses a separate
`managed_wiki_<generation>` collection for each attempt, never `wiki_pages`.
Long articles are covered completely by chunks of at most 2,000 Unicode code
points with 200 code points of overlap. This replaces the preview's prefix-only
compatibility hotfix. Markdown and page revisions remain unchanged. Each point
records its page ID/revision, snapshot revision, chunk index and source start/end
offsets. Offsets count Python Unicode code points, not UTF-8 bytes or browser
UTF-16 units. An empty article embeds its title while retaining an empty source
range. The per-call character bound is not a provider-specific token guarantee;
real provider limits and model quality still require separate acceptance.

The injected embedder's `embed(text)` method receives each bounded chunk; vectors must
match the configured dimension and contain only finite values. Pass `None` to
infer the dimension from the actual page embeddings instead of a model-name
guess. An empty auto-sized snapshot makes one explicit embedding probe. All vectors are
validated before collection creation. Validated points use an anonymous temporary
spool instead of retaining all vectors in memory. Writes use batches of at most
64 points with `wait=True`, and a build
returns only after they complete. An empty snapshot creates an empty searchable
collection. `search(generation, query, limit=10)` returns `id`, page `revision`, and
`score`, with cosine similarity and a limit in 1–1000 **articles**. Qdrant's grouped
query (`group_by=id`, best hit per group) prevents many chunks of one long article
from crowding other articles out of a limited result set. Existing single-point
generations retain the same page ID payload and remain group-readable, but the
new configuration identity requires a rebuild before they can represent complete
chunk coverage. The pinned-server integration suite includes tail retrieval and
article grouping; local embedded-client results alone do not establish hosted
server compatibility.

Configured vector workers emit bounded progress logs with page X/Y, chunks,
embedding duration and elapsed build time. Failures log exception type and an
HTTP status when available; page IDs, source text and raw provider messages are
excluded. The configured standalone server enables these INFO messages unless a
module logging level was explicitly set; existing application handlers are
preserved. An embedding-progress line is not proof of a completed upload or
published index receipt.

Git startup still acquires existing content before serving, but it no longer
performs synchronous embedding work before API startup. The lifecycle-owned
delivery worker builds indexes afterwards. Content reads and lexical search stay
available while semantic retrieval reports pending until the complete generation
is ready. The lifecycle supervisor owns separate Git and index loops with their
existing independent cross-process locks and separate retry backoffs. Holding an
embedding request no longer holds the delivery lock: local edits can push and
external changes can pull while an older index snapshot is building. Both loops
are joined before their provider clients close, including partial startup failure.
The explicit one-shot delivery command still performs both jobs synchronously.

New vector generations can reuse validated points from the last ready generation
of the same configuration. Page ID, chunk position/source range and source hash
must match; the reused vector must have a valid shape. The earlier chunk format
without hashes can only be reused at an identical page revision. Changed chunks
are embedded; every copied point receives fresh page/snapshot provenance. The
old collection remains immutable. A small append can therefore embed only its
changed final chunk, and an identical-text revision can reuse all its vectors.

The last ready source is recorded separately in the existing SQLite index ledger
and protected during pruning. A failed new attempt does not lose that source;
restart/retry can still reuse it without publishing a partial generation. Config
changes and explicit `--rebuild` deliberately embed everything. A missing source
collection falls back to a full build; a source read failure aborts rather than
silently spending model calls on an unavailable Qdrant backend.

This is incremental **embedding work**, not in-place mutation of a live index:
each new generation still scans a content snapshot, reads reusable provider
vectors and uploads a complete isolated collection. Graph generations still
rebuild. Idle current-index polling skips full snapshot derivation. Full chunk
coverage can require more model calls and temporary disk space than the old
prefix-only index; cold builds and forced rebuilds retain those costs.

Auto-sized searches read the dimension from the persisted collection and validate
the actual query vector against it, including after a process restart. Provider
dimension drift fails rather than silently serving a different vector space.
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

The snapshot derivation identity is defined in the `schema` field of
[`configured_indexes`](../backend/src/second_brain/wiki/index_config.py).
That source is authoritative for the checked-out revision. Snapshot derivation
projects titles, excerpts and explicit links with bounded Markdown code,
comment, container, HTML and link
metadata rules. This is not complete renderer/parser parity. An older derivation
identity invalidates ready receipts even if the Markdown/Git revision is unchanged.
The startup delivery worker, or the explicit one-shot command below, builds fresh
generations before derived retrieval becomes current again. The fingerprint is
shared, so both configured backends rebuild; enabled vector indexing can make
new paid embedding requests. This does not rewrite Markdown/history or delete
old provider generations; normal retention rules still apply.

The coordinator now records each new build attempt in a local retention ledger.
Cleanup is deliberately operator initiated and dry-run by default. It protects the
current ready receipt and enough recent ready generations actually present on
the configured provider to reach `--keep-ready` in total. Missing provider
generations in the local ledger do not consume that retention count. A missing
current generation still fails retrieval; retaining a backup does not promote it
as a replacement current receipt. Cleanup observes a minimum age, takes the same
worker lock as builders, and takes an
exclusive lock against semantic/graph readers before deletion. Provider targets
not present in this coordinator's ledger are reported as untracked and never
deleted. This includes legacy generations discovered after an upgrade; cleanup
does not guess their ownership. Provider errors are returned only as sanitized
per-index states.

## Enable and operate

Run the managed API or MCP profile with `SECOND_BRAIN_WIKI_VAULT` pointing to its
managed vault. `configured_indexes(store)` reads the same `.env`, then `../.env`,
then process ENV precedence as the legacy configuration. An explicitly supplied,
nonempty `NEO4J_URI` or `QDRANT_URL` enables that index automatically. Settings'
default localhost endpoints and a chat key alone do not start provider work.
Managed flags override detection: `0` disables, `1` requires the provider,
empty/unset inherits the configured endpoint. Other flag values are refused.

| Backend | Opt-in flag | Required configuration |
| --- | --- | --- |
| Graph | `SECOND_BRAIN_WIKI_GRAPH_INDEX` | `NEO4J_URI`, existing `NEO4J_USER`/`NEO4J_PASSWORD`; optional `NEO4J_DATABASE` |
| Vector | `SECOND_BRAIN_WIKI_VECTOR_INDEX` | `QDRANT_URL`, existing `LLM_PROVIDER` and embedding credentials/model; optional `QDRANT_API_KEY` and `SECOND_BRAIN_WIKI_VECTOR_DIMENSION` |

An enabled vector index loads the existing embedding provider factory.
Choose `LLM_PROVIDER=openrouter` with server-side `OPENROUTER_API_KEY`, or
`LLM_PROVIDER=gcp` with `GCP_API_KEY`. Set `EMBEDDING_MODEL` deliberately and
optionally set `SECOND_BRAIN_WIKI_VECTOR_DIMENSION` to that model's actual output.
Blank/unset dimension uses the actual provider vectors; no new dimension setting
is required for an existing installation. An explicit dimension is still checked.
`OPENROUTER_EMBEDDING_PROVIDER` and `GCP_ENDPOINT_URL` are optional routing
settings for their respective providers. Keep keys outside the vault and
frontend; these commands can make paid embedding requests when vector indexing
is enabled. Provider/model quality remains a separate acceptance gate.
Without configured endpoints or explicit enablement, startup needs neither backend nor an
embedding provider. Keep the same configuration in API, MCP, and worker processes.

The managed Compose file passes the table's flags, endpoints, credentials,
dimension and provider/model routing to both API and MCP. Put them in the same
operator ENV file supplied with `--env-file`; they are server-side only. An empty
`NEO4J_DATABASE` uses the server's default database and an empty `QDRANT_API_KEY`
means no API-key authentication. Database services are not started by this
Compose file: supply reachable endpoints, not a host-only localhost address.

Existing explicit provider endpoints now activate managed indexes without new
flags, and the vector dimension is inferred as in the legacy workflow. This is
real provider work, including potentially paid embedding requests on rebuild;
use an explicit `0` to disable it for an isolated demo or inspection. Preserve
the original databases and verify
current graph/vector receipts plus semantic and graph_rag requests before
accepting a personal migration. Isolated generations do not overwrite legacy
collections or authorize deleting them.

Run from the repository root with the locked backend dependencies and the
explicit provider configuration above. Select Poetry's actual Python:

```sh
(cd backend && poetry sync --no-interaction)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
export PYTHONPATH="$PWD/backend/src"
```

Build configured indexes once:

```sh
"$WIKI_PYTHON" -m second_brain.wiki.indexes
```

Force fresh builds even for an already current snapshot:

```sh
"$WIKI_PYTHON" -m second_brain.wiki.indexes --rebuild
```

Preview cleanup candidates while retaining the current and previous ready
generation and requiring a 24-hour grace period:

```sh
"$WIKI_PYTHON" -m second_brain.wiki.indexes --prune
```

After reviewing that output, apply the same plan explicitly:

```sh
"$WIKI_PYTHON" -m second_brain.wiki.indexes --prune --apply
```

`--keep-ready` and `--min-age-hours` adjust the conservative defaults. Cleanup
never runs as part of startup or ordinary delivery. A busy builder or reader
returns `cleanup: busy`; retry rather than bypassing the lock.

The index module remains an explicit one-shot worker. Managed REST/MCP/stdio
factories now own [recoverable delivery](managed-delivery.md) by default, which
runs configured indexes after saves and startup. Disable it with
`SECOND_BRAIN_WIKI_DELIVERY=0` for manual operation. One-shot runs discover the
latest authoritative Git snapshot and skip ready indexes unless `--rebuild` is
supplied. Publication and index completion are
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

A lost ready provider generation is also unavailable, not an empty result.
Neo4j reads check the generation marker within their read transaction; Qdrant
reports a missing collection. Local receipts alone do not prove provider storage
still exists. After repairing the provider, use `--rebuild` explicitly: the
ordinary worker skips an unchanged ready receipt. Rebuild creates fresh derived
generations without changing authoritative Markdown or Git history.

The separate [disposable server acceptance](managed-index-acceptance.md) exercises
these contracts against real Neo4j and Qdrant containers with synthetic vectors.

Builds materialize the full snapshot and all embeddings in process memory. The
operator-controlled retention path bounds future generation growth, but streaming
builds and provider-scale measurements are still required for production scale.

Validation on 2026-10-10 also started real Uvicorn REST and HTTP MCP listeners:
the MCP SDK and REST returned identical semantic results; a content mutation
made semantic reads pending while lexical search remained available; an explicit
worker run recovered current results. This used embedded Qdrant and synthetic
embeddings, not a live Neo4j server, hosted Qdrant, or external embedding model.
