# SecondBrain 2.0 review handoff

This page is the high-level handoff for the `secondbrain-2.0` branch. It is a
review aid, not a production approval. Update its evidence snapshot only after
running the named checks on the exact published commit.

## Current status

The branch is a coherent local development preview: the managed wiki, direct
MCP, article UI/editor/history, knowledge galaxy, bounded read-only chat, PWA,
first-start/import/export, recoverable indexing and guarded Git delivery are
implemented. It is **not yet release- or merge-ready** because real model/hosted
provider, production HTTPS, private migration and physical-device gates remain open.
Disposable Docker/nginx/volume acceptance now runs separately in CI; require
the actual results for the reviewed revision before relying on that evidence.

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
list/read/save/delete, link resolution and explicit incoming links,
lexical/semantic/GraphRAG search, graph,
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

With a local Docker Engine and Compose v2, `make acceptance-stack` builds and
exercises disposable managed containers, the nginx boundary, shared REST/MCP
writes, restart persistence and independent-volume backup/restore. See the
[stack acceptance guide](managed-stack-acceptance.md) for isolation and CI
evidence. Adding the runner does not itself establish a passing Docker gate.

The [managed index acceptance](managed-index-acceptance.md) runs Neo4j and Qdrant
Testcontainers with real adapters and deterministic synthetic embeddings. It
covers shared reads, freshness, generation loss/rebuild, server restart,
retention and a bounded 320-page snapshot. This does not establish real-model
quality, hosted providers or production load behavior.

The opt-in [SSH Git acceptance](managed-ssh-acceptance.md) uses an owned agent,
fresh keys and a loopback OpenSSH server to exercise authenticated snapshot
delivery and refusal of missing/changed host trust or unauthorized client keys.
Its independent CI result must be checked; it does not validate hosted deploy-key
permissions or operator credential mounts.

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

Verified published implementation baseline `f426c41fdee800cbd580f360eeaf8ba7b551fd14`
(tree `739f1706be853fd3765061b4741fb0cd51a94416`, 2026-10-11).
These results identify that exact baseline; for later commits inspect the
current [draft PR #18](https://github.com/JonasKruegerCode/SecondBrain/pull/18)
and its matching CI runs rather than treating older counts as current.

- All six workflows passed: Backend #82, Frontend #61, Managed stack #24,
  Managed index #22, Managed SSH #11 and Managed browser #7. Backend Ruff and
  strict MyPy over 88 source files passed, with 307 tests and 12 opt-in skips
  (52.21 seconds); the backend image build also passed.
- [Managed browser #7](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38175845458)
  passed 35/35 real API/Vite cases (22.5 seconds; 24.501 with services).
  Downloaded artifact `11715972062` confirms no external model calls and no
  retained success vault. ZIP SHA256:
  `3d1f9795f7b799b2d3b3eb90603409ad05bdb23cdb5d0581ae07b6870683e6e7`.
- [Managed stack #24](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38175845454)
  passed 72 structural gates plus six Chromium checks in 59.598 seconds.
  Downloaded artifact `11714744972` confirms a forced backend address change
  without frontend restart, preserved API read/write/query/history contracts,
  synthetic HTTPS/password protection and independent-volume restore. Cleanup
  is confirmed. ZIP SHA256:
  `5ca2a9e0efd5be3319e455577cf30c24ad904909fdc98eb7755f6aa4e1cd7eae`.
- Both artifacts expire on 2026-10-18 and identify CI test-merge `b19fb1a`,
  not a merge to main. Built Home desktop/narrow screenshots were opened and
  inspected. This is browser emulation and synthetic infrastructure.
- Browser coverage includes revision conflicts/retries, real link/graph refresh,
  article reload, nested-list/code rendering boundaries, bounded local chat
  storage and recovery, and PWA save/update coordination across tabs. Scripted
  chat transport checks do not establish real-model quality.
- Real isolated Neo4j/Qdrant with synthetic embeddings and owned loopback
  OpenSSH/agent delivery remain separately evidenced by their dedicated guides.
  Hosted configuration, production load and private Git permissions remain open.
- A read-only merge-tree comparison against `main 1f0cd1e` had no conflicts.
  The earlier intermittent ordinary restart failure remains unexplained;
  controlled address-change recovery is independently verified.

## Known release gates

- real OpenRouter multi-turn result and answer-quality inspection
- hosted Neo4j, Qdrant and embedding-provider integration and retention under load
- production authenticated reverse-proxy/HTTPS operation and off-host restore;
  disposable Compose build/start/restart and independent-volume recovery have
  separate CI evidence
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
