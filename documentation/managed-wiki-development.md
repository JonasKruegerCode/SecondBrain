# Managed wiki: first runnable development milestone

This is an **opt-in development profile**, not the completed 2.0 release. It uses
real local Markdown content and Git history, without Redis, Neo4j, Qdrant, remote
Git, an embedding provider, or a chat model. Legacy APIs and workers remain
unchanged; the default legacy Compose stack serves `legacy.html`. Do not attach
the legacy worker or a direct file writer to a managed vault.

## Start and stop

From the checkout, install the locked backend dependencies with `cd backend &&
poetry install`, then frontend dependencies with `cd frontend && npm ci`. From
the repository root run:

```sh
make demo PYTHON=backend/.venv/bin/python
```

Open <http://127.0.0.1:5173>. The demo uses `.demo/vault`, separate from the legacy
`vault` directory and Docker volumes. Ctrl+C stops API and frontend together.
The first launch explicitly seeds a fictional atlas; later launches retain all
edits. To start empty in another directory:

```sh
PYTHONPATH=backend/src backend/.venv/bin/python scripts/run-wiki-demo.py \
  --vault .demo/empty-vault --empty
```

The seeder's repeat-verification and interrupted `--resume` behavior are in
[demo-start.md](demo-start.md). It never overwrites an existing nonempty wiki.
No chat response or external semantic index is simulated by the demo.

The separate `docker-compose.wiki.yml` describes an empty managed installation
on `127.0.0.1:8080`. Its container build/start has not yet been verified. It uses
an independent `managed_wiki` volume and does not expose the backend port. Put
authenticated HTTPS reverse proxy protection in front before exposing it beyond
localhost. Existing production proxy credentials are not changed. This milestone
does not migrate the production vault. Explicit local Git import and independent
HTTP MCP startup are described below.

## Publication contract

The directory's `.wiki.git` is a bare local Git repository. `refs/heads/wiki`
points to the authoritative published snapshot. Trees contain UTF-8
`pages/<id>.md`, per-page revision tokens, and durable request receipts. The
working directory is not a second authoritative filesystem writer.

A save validates the page revision that the client actually read. Null revision
means create-only. Content, revision and retry receipt publish with a single
`git update-ref` compare-and-swap. Concurrent unrelated writes may be retried;
the page base revision never changes implicitly. Revision tokens change across
delete/recreate even when the Markdown is identical. A lost response is retried
with the same request ID and identical payload; a reused ID with a different
payload fails. Earlier published versions remain in local Git history.

Prepared but unpublished objects are invisible to reads. The reference is the
publication boundary; there is no export/journal to reconcile at startup.
Back up the complete managed directory, including hidden `.wiki.git` and the
demo marker where present. Avoid pruning request/history objects arbitrarily.
Normal operation requires local Git; remote/provider failure is independent.

Mutation receipts record external indexes **pending** at publication time; current
progress is available from `/api/wiki/index-status`. Optional snapshot adapters
now support Neo4j, vectors, and bounded non-generative GraphRAG retrieval; see
[managed indexes](managed-indexes.md) for configuration and explicit worker runs.
Remote synchronization remains **not_configured**. The immediate graph derives
explicit wikilinks and typed relations from one content snapshot, resolves unique
titles, and reports missing/ambiguous targets without inferring dependencies.
Frontend title-link resolution and galaxy layout remain unfinished.

## REST and MCP

Managed REST is `/api/wiki`: page listing, page read/create/save/delete, lexical
search, snapshot graph, and recent page history. Saves require `markdown`,
`base_revision`, and `request_id`. Reads are independent of Git pulls and models.
All responses use `Cache-Control: no-store`. Browser writes reject foreign
origins; the optional `SECOND_BRAIN_WIKI_API_KEY` requires a server-side Bearer
credential on all managed endpoints. Ordinary browser use should retain
reverse-proxy authentication; no provider key is sent to the frontend.

Local MCP uses the **same** WikiStore:

```sh
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/managed-vault \
PYTHONPATH=backend/src backend/.venv/bin/python -m second_brain.wiki.mcp
```

This is a local stdio transport. The `wiki://guidance` resource documents concise
article openings, headings, links at the point of use, stable IDs, source
discipline, revision conflicts and exact retries. Managed tools are get/list/
search/save/delete/graph/history. Legacy remember/recall remain in the separate
legacy profile, and are absent here. No automatic editorial repair runs.

Streamable HTTP provides those same tools at `/mcp`, with an optional Bearer
key and explicit Host/Origin allowlists. See [managed-mcp.md](managed-mcp.md)
for local startup, reverse-proxy configuration and transport differences from
legacy. A real SDK client against a running MCP server was checked alongside
REST against the same isolated vault.

## Controlled local Git import

See [wiki-import.md](wiki-import.md) for importing a complete clean local Git
repository with an optional page-directory prefix. An import validates all
pages before atomically replacing the managed page set; an existing destination
requires its reviewed snapshot head. The source stays unchanged. Original
source commits, including history outside the selected prefix, remain reachable
and appear in page history through the source-path mapping. No remote credentials
or Git configuration are copied. Shallow/incomplete history, duplicate IDs,
dirty sources, invalid Markdown and missing prefixes are refused. Empty input
cannot erase a populated wiki. This is not automatic remote synchronization.

## Verification and remaining work

Backend tests exercise real local Git, genuine separate-process writers, stale
revisions, request reuse, delete/recreate, fault injection before/after the
publication boundary, restart, graph refresh, code-example links, API failures,
access controls, MCP calls and safe fictional seeding. Fault injection is not a
power-loss durability test. Neo4j/Testcontainers and deployed service failures
have not been tested by these cases.

The frontend provides a bright responsive Home, safe rendered Markdown,
aliased wikilinks, direct URLs, browser navigation, persisted start page,
lexical search and a revision-aware editor with conflict drafts. The original
frontend is retained as a separate build entry for legacy deployment. Screenshot
inspection and running-browser tests are required after UI changes; build/type
checks alone do not establish visual quality.

Not complete: remote Git synchronization and Markdown export workflow,
live provider/deployment integration, index scheduling/retention/scale, richer
Markdown navigation/history UI,
galaxy, iterative OpenRouter chat, installable PWA, deployment packaging and
full migration acceptance. Device installation and real-model chat quality are
not claimed. Do not use this milestone as the final production migration.

### Browser regression command

Start the isolated demo, then run `cd frontend && npm run test:browser`. Install
Playwright Chromium once with `npx playwright install chromium`; an existing
compatible executable can be selected with `PLAYWRIGHT_EXECUTABLE_PATH`. Use only
a disposable synthetic vault: the suite deliberately creates, edits and deletes
fixture pages. Test artifacts are kept under the ignored `.demo` directory.

On 2026-10-10: 163 nonintegrative backend tests passed, repository Ruff and strict
MyPy passed (63 source/test files). The prior UI milestone passed TypeScript,
both Vite builds and nine real-API browser regressions in Chromium; this backend
index change did not repeat that visual acceptance. Desktop (1440 pixels) and narrow
(390 pixels) screenshots were inspected. The demo launcher was started and
stopped against real services. New real HTTP REST/MCP semantic regression used
embedded Qdrant and synthetic embeddings. Docker deployment, hosted index services,
remote synchronization, real-model chat and device installation remain untested.

The imported atlas was also opened in the running browser, and desktop/mobile
screenshots were inspected. The narrow-view table inspection exposed excessive
word wrapping; tables now scroll inside a keyboard-focusable region with readable
column widths. A real demo-table regression covers 390px and 1440px views,
keyboard scrolling and absence of page overflow.

A synthetic 500-page Git import took 8.8 seconds in the development environment.
Listing, current Markdown graph and lexical search took approximately 42–56 ms.
Batched reads use one immutable tree and two Git processes; an equivalent
previous 500-page listing took 5.22 seconds versus 0.049 seconds with the batch
reader and identical content/revision results. These are local fixture timings,
not a production scalability guarantee. Concurrent publication during a batch
read is covered by a regression ensuring the returned graph remains on its
declared snapshot.
