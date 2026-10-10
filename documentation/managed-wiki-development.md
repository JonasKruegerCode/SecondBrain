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

For a deliberate empty/template/local-Git installation choice, use the
[first-start command](first-start.md). It does not start services, seed on API
startup, or replace a populated wiki. [Markdown export](wiki-export.md) prepares
a separate, revision-guarded content-only directory without copying Git internals.
[Explicit managed Git sync](managed-git-sync.md) publishes or imports reviewed
snapshots with durable acknowledgements and a guarded normal push. See [recoverable delivery](managed-delivery.md) for the factory-owned worker
and explicit opt-in remote bootstrap.

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
Remote synchronization is **not_configured** unless deliberately opted in;
`/api/wiki/delivery-status` reports fresh workspace index progress and cached Git
verification separately. Factory-owned workers reconstruct pending work after
saves and restarts. The immutable save receipt remains publication-time evidence. The immediate graph derives
explicit wikilinks and typed relations from one content snapshot, resolves unique
titles, and reports missing/ambiguous targets without inferring dependencies.
The browser uses the same target resolver for ID/title links, ambiguous choices and missing links. A first snapshot galaxy is available at `/galaxy`; its topology grouping is a navigation aid, not a semantic classification.

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
lexical search, article contents, on-demand local Git history, and a revision-aware
editor with conflict drafts and separate delivery progress. The original
frontend is retained as a separate build entry for legacy deployment. Screenshot
inspection and running-browser tests are required after UI changes; build/type
checks alone do not establish visual quality.

Not complete: production Git credential provisioning, live provider/deployment integration, index
retention/scale, frontend title-link ambiguity resolution,
galaxy, iterative OpenRouter chat, installable PWA, deployment packaging and
full migration acceptance. Device installation and real-model chat quality are
not claimed. Do not use this milestone as the final production migration.

### Browser regression command

Start the isolated demo, then run `cd frontend && npm run test:browser`. Install
Playwright Chromium once with `npx playwright install chromium`; an existing
compatible executable can be selected with `PLAYWRIGHT_EXECUTABLE_PATH`. Use only
a disposable synthetic vault: the suite deliberately creates, edits and deletes
fixture pages. Test artifacts are kept under the ignored `.demo` directory.

On 2026-10-10: 234 nonintegrative backend tests passed; repository Ruff and strict
MyPy passed (75 source/test files). New exporter/setup/remote/CLI coverage uses
real local Git, with frozen snapshots, no-replace outputs, byte preservation,
conflicts, lost acknowledgements, restart, request identity, and prepared-object
retention. A trusted generated pre-push guard validates Git's advertised remote
OID before a normal non-force push; actual deletion/rewind race tests passed.

A new twelve-page template -> plain export -> committed Git -> managed import
roundtrip preserved every Markdown byte. The imported app was actually started;
eleven browser tests against the actual API passed (one deliberate history-error
injection uses an intercepted failed response), desktop 1440px/mobile 390px screenshots were
inspected, and real network MCP SDK initialize/read/guidance/save agreed with
REST revisions. No observed JavaScript errors or page overflow. Frontend TypeScript and both Vite builds passed for the updated UI. A new
read-only review found and corrected worker lifecycle restart and baseline
validation issues; pending payloads and external-change conflicts have real Git
regressions.

The preceding index milestone started real REST/MCP semantic services with
embedded Qdrant and synthetic embeddings. Docker is unavailable here; container
build/deployment, hosted index/embedding providers, authenticated production Git,
real-model chat and actual device installation remain untested.

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


## Link navigation and snapshot galaxy

Wiki links use exact page IDs first, then case-insensitive unique titles. Duplicate
titles offer explicit candidate cards; missing targets are marked within prose.
Title aliases, cross-page heading fragments and `[[#Heading]]` work alongside
direct URLs and browser history. Rendering still ignores wikilinks inside code.
The bounded read endpoint `/api/wiki/resolve-links?target=...&source=...` shares
the graph resolver and returns its content revision. Article links are hydrated
in small batches; their resolution route remains available on request failure.
A late response for an abandoned article cannot replace the current edit target.

The galaxy reads `/api/wiki/graph`, which derives resolved edges from one
immutable Markdown snapshot. Cores and groups are deterministic link-topology
neighborhoods: prefer highly linked local hubs over connectors spanning at least
80% of a component; additional cores are separated by at least two links. Assign
pages to their nearest core, with deterministic ties. A generic wikilink never
implies a dependency. The evidence panel preserves actual source/target direction
and declared relation labels. Unresolved targets do not become invented stars.
Use the explicit refresh link to read a newer revision after saves/deletions.

Overview, focused neighborhood, star selection, local title/ID search and article
navigation share a keyboard-accessible sidebar. Zoom/pan are bounded. On narrow
screens, controls remain reachable and a list view offers a reduced alternative.
Above 250 pages or 800 links, list view is the default and skips SVG construction.
The map can still be selected explicitly; large-map performance is not accepted.
Grouping changes may move stars after a content mutation. Semantic communities,
stable incremental placement, richer overview aggregation and visual depth remain
quality work for the final galaxy acceptance; this first view is not that signoff.

Validated against actual isolated demo services: 235 nonintegrative backend tests,
Ruff and strict MyPy, TypeScript and both Vite entries. Fifteen Chromium cases in
total cover reader/editor regressions, title ambiguity/deletion, fragments,
delayed real responses and galaxy save/link/delete refresh. Desktop 1440 and
mobile viewport 390 screenshots were inspected; light-shell contrast, label
collisions and navigation overflow were corrected. Browser emulation is not a
physical-device installation or hosted-provider/model test. One history response
uses a synthetic error and one real page response is delayed; the remaining
content and mutations use real services.
