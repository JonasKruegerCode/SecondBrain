# SecondBrain 2.0 review handoff

This page is the high-level handoff for the `secondbrain-2.0` branch. It is a
review aid, not a production approval. Update its evidence snapshot only after
running the named checks on the exact published commit.

## Current status

The branch is a coherent local development preview: the managed wiki, direct
MCP, article UI/editor/history, knowledge galaxy, bounded read-only chat, PWA,
first-start/import/export, recoverable indexing and guarded Git delivery are
implemented. It is **not yet release- or merge-ready** because real provider,
container/HTTPS, private migration and physical-device gates remain open.

## Architecture and data flow

Markdown stored in a local bare Git repository is authoritative. A save validates
the revision read by the caller, writes page content plus its retry receipt into
one candidate snapshot, then publishes that snapshot with a compare-and-swap ref
update. REST, the browser and direct managed MCP all use the same `WikiStore`;
there is no second loose-file writer.

Neo4j, Qdrant/embeddings and remote Git are recoverable derived services. Their
generation or delivery receipts remain separate from the Markdown publication
receipt, so a pending or failed provider cannot be reported as current. The wiki
continues to provide exact reads, lexical search, local history and explicit
Markdown graph navigation without those providers.

The optional chat is a bounded OpenRouter function-calling loop over search,
exact page reads and graph neighbors. It has no write tool and no backend
conversation archive. Visible sources contain only pages the model actually
read; browser-local conversations can be deleted.

## User and operator paths

- First start explicitly chooses an empty wiki, the fictional template or a
  reviewed local Git import. A nonempty destination is never seeded implicitly.
- The main user flow is Home -> article and wikilinks -> search/history/editor ->
  galaxy -> optional chat.
- Save conflicts preserve the local draft and require a fresh read plus deliberate
  reconciliation. Lost acknowledgements are retried with the same request ID and
  payload.
- Backup/restore includes Git history, durable local ledgers and demo metadata.
  Content-only export is separate and is not a full operational backup.
- Remote Git delivery requires reviewed local and remote heads. It never performs
  an automatic pull, merge, force-push or conflict adoption.

## Public interfaces

The managed REST surface under `/api/wiki` covers health, page
list/read/save/delete, link resolution, lexical/semantic/GraphRAG search, graph,
history, index/delivery status and bounded chat. Mutation requests carry
`base_revision` and `request_id`.

Managed MCP exposes ten deterministic tools: page read/list/search/save/delete,
graph/neighbors, history, index status and delivery status. The
`wiki://guidance` resource documents the editorial and retry contract.
`remember` and `recall` remain only in the separately configured legacy
profile.

## Reproduce the demo and checks

Install the locked Python and Node dependencies, then from the repository root:

```sh
make demo PYTHON=backend/.venv/bin/python
make acceptance PYTHON=backend/.venv/bin/python
make check
```

The demo and acceptance commands use only the public fictional Lantern Bay
fixture. The acceptance runner starts the real API and Vite frontend, runs the
normal Playwright suite and writes an ignored structural record below
`.demo/acceptance/`. It clears inherited OpenRouter access.

With explicit approval for paid external calls and a real key:

```sh
OPENROUTER_API_KEY=... make acceptance-openrouter PYTHON=backend/.venv/bin/python
```

This is the only check above that establishes real OpenRouter behavior. It still
does not establish hosted index, deployment or device behavior.

## Evidence snapshot

On published commit `443819164cd56b9eba11af618be33f8654c943f3`
(tree `17a701e06d5a64db5200aac3919967bc34779887`, 2026-10-11):

- GitHub Backend run #57 and Frontend run #36 completed successfully.
- Ruff passed and strict MyPy passed across 84 backend source/test files; 273
  nonintegrative backend tests passed.
- TypeScript without emit and the Vite production build passed.
- the supervised disposable run against the real local API and Vite frontend
  passed 26/26 Playwright cases in 17.7 seconds against a fresh fictional
  12-page vault; the complete run took 20.237 seconds and removed its success
  vault.
- the added graph regression confirms that a Wikilink rendered inside a nested
  Markdown list is also present in the same managed graph snapshot, while
  genuine indented and fenced code examples stay excluded.
- desktop 1440x1000 Home/Chat, narrow 390x844 Home/Chat and the actual initial
  mobile Chat viewport were inspected. The latter opened at `scrollY=0` without
  forcing composer focus. This is emulation, not physical-device evidence.
- representative small muted text on the light wiki surfaces is guarded at a
  minimum 4.5:1 contrast ratio by the browser suite.
- a scripted-provider acceptance exercised two turns, real managed-store reads,
  source/tool limits and the read-only boundary. It is not a real model-quality
  result.
- a fresh merge-tree check against the then-current `origin/main` completed
  without conflicts. Draft PR #18 remained open, mergeable and deliberately
  not marked ready for review.

## Known release gates

- real OpenRouter multi-turn result and answer-quality inspection
- hosted Neo4j, Qdrant and embedding-provider integration and retention under load
- actual Compose image build/start, named-volume recovery, authenticated
  reverse-proxy/HTTPS operation and off-host restore
- reviewed Git credentials and migration of the selected private legacy vault
- physical Android/iOS installation, standalone launch, icons, updates, touch and
  screen-reader inspection
- final end-to-end demo rehearsal followed by an updated evidence snapshot and
  review decision

Do not describe the branch as production-cut-over, release-ready or fully
accepted while any material gate above remains open.

## Pull-request summary

SecondBrain 2.0 replaces the primary experience with an agent-maintained,
Git-backed wiki while retaining optional graph, GraphRAG and vector retrieval.
It adds one revision-safe content authority shared by the browser, REST and MCP;
a bright responsive article/editor/history interface; a curated evidence-based
galaxy; bounded read-only chat; explicit first-start, migration, backup and
delivery workflows; and an online-first PWA that does not cache private data.

The implementation keeps the legacy memory profile isolated, treats external
indexes and remote Git as recoverable derivatives, and makes conflicts, retries
and partial states visible. Public fixtures are synthetic. The local regression
and demo paths are reproducible, while the provider, production infrastructure,
private migration and physical-device gates listed above remain explicitly open.
