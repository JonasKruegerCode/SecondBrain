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
read. Browser-local conversations are bounded and deletable; each write merges
the current store, and bounded deletion tombstones prevent a stale tab from
losing or resurrecting independent conversations.

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
make acceptance-first-start PYTHON=backend/.venv/bin/python
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

The normal demo and acceptance commands use the public fictional Lantern Bay
fixture. The first-start check begins empty and creates separate fictional
pages through real REST services. Its two browser phases surround an actual
API/Vite stop and restart on the same owned vault, checking exact revisions,
content, saved start page and navigation. Delayed real graph responses and
scripted transport aborts check loading/error/stale-route handling; they do not
establish real outage behavior. Browser profile/page receipts are local phase
inputs and are never uploaded; successful runs remove them and the vault.
The acceptance runner starts the real API and Vite frontend, runs the
normal Playwright suite and writes an ignored structural record below
`.demo/acceptance/`. It clears inherited OpenRouter access.

For the opt-in tall-map probe, create an isolated vault with
`python -m second_brain.wiki.scale_demo --vault .demo/tall-vault --pages 320 --groups 24`,
start `scripts/run-wiki-demo.py --vault .demo/tall-vault`, then run
`PLAYWRIGHT_TALL=1 npm run test:browser -- e2e/tall.spec.ts` from `frontend`.
Use the installed backend environment and `PYTHONPATH=backend/src` for the
Python commands. This uses real Markdown/Git and graph services, with no model
calls; it is separate from the normal browser CI suite.

With explicit approval for paid external calls and a real key:

```sh
OPENROUTER_API_KEY=... make acceptance-openrouter PYTHON=backend/.venv/bin/python
```

This is the only check above that establishes real OpenRouter behavior. It still
does not establish hosted index, deployment or device behavior.

## Evidence snapshot

Verified published implementation baseline `54ccdd87a97e844aca9bb9790e6749bac239ae8f`
(tree `f94328a21d62eb60dbfec782b6e9dcb992f29347`, 2026-10-12).
These results identify that exact baseline; for later commits inspect the
current [draft PR #18](https://github.com/JonasKruegerCode/SecondBrain/pull/18)
and its matching CI runs rather than treating these counts as current.

- A new two-tab browser test first reproduced an independent-conversation loss
  and deletion resurrection. After the persistence fix, the focused real-browser
  chat suite passed 9/9. Strict app/E2E TypeScript and the production build pass.
- The complete local real API/Vite acceptance passed 50/50 in 68.482 seconds.
  Its structural result records `external_model_calls=false` and
  `vault_retained=false`; this is not a real-model check and retains no success
  vault.
- All six workflows passed: [Backend #91](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38203081037),
  Frontend #70, [Managed stack #33](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38203081036),
  Managed index #31, Managed SSH #20 and
  [Managed browser #16](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38203081052).
  Backend Ruff and strict MyPy over 88 files passed with 328 tests and 12
  explicit opt-in skips (58.77 seconds); backend and frontend image builds pass.
- Managed index passed 7/7 against real isolated Neo4j/Qdrant with synthetic
  embeddings. Managed SSH passed 5/5 with its owned agent and loopback OpenSSH.
  The managed stack passed its built HTTPS/auth, controlled address-change and
  independent-volume recovery checks, including six Chromium proxy checks.
- Browser coverage includes revision conflicts/retries, real link/graph refresh,
  article reload, nested-list/code rendering boundaries, bounded local chat
  storage/recovery/deletion across stale tabs, and PWA save/update coordination.
  Scripted chat transport checks do not establish real-model quality.
- Narrow-screen galaxy pointer navigation reveals a chosen constellation's map
  or the selected page's article and exact link evidence. Touch-emulation checks
  include selecting a neighbor after scrolling the evidence panel, opening its
  article, and keeping the map hidden in list view. Keyboard focus and desktop
  layout remain separate paths. Focused maps fit the available aspect ratio and
  keep label size stable across zoom/resize. Spaced stars use 44-pixel hit circles;
  up to 120 stars, actual spacing caps targets to prevent overlap. Larger
  constellations use a conservative elliptical-ring spacing bound without a
  quadratic scan, retaining disjoint targets and the precise page-list path.
  Dense 40- and 128-page maps have rendered-spacing and selection checks; small
  nonoverlapping targets do not establish comfortable physical touch usability.
  Overview titles/counts and bridge numbers use screen-scaled font sizes;
  narrow maps use two columns with measured middle ellipsis, preserving full
  names in constellation details and tooltips. Counts avoid nearby labels or
  defer to the exact link title/details when no local placement fits. Resize
  retains the focused keyboard star across column changes. If fitting every
  row would crowd readable labels, an explicitly labeled overview window opens
  on the full retained map. Panning and keyboard focus can reach its final row;
  small overviews still fit all rows. A separate real 320-page/24-constellation
  probe checks retained cores/bridges, 320/390/1440-pixel layouts, pan, zoom,
  reset and distant keyboard selection. Real group changes and core deletion
  also check fresh revisions, deterministic replacement cores, missing-target
  evidence, list membership and article navigation. The old snapshot reports
  a deleted article as missing until refresh; the scale probe restores and
  compares the original nodes and edges after its mutations. Very dense maps and
  physical touch ergonomics remain separate QA concerns; emulated taps do not
  establish device usability.
- CI artifacts contain only synthetic structural/browser evidence and expire
  under the workflows' seven-day retention. They are browser emulation and
  synthetic infrastructure, not physical-device or production evidence.
- Hosted index configuration, production load and private Git permissions remain
  open despite the isolated provider and SSH fixtures.
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
