# SecondBrain 2.0 review handoff

This is the current review entry point for the `secondbrain-2.0` branch.
[PR #18](https://github.com/JonasKruegerCode/SecondBrain/pull/18) remains **Draft**.
The managed wiki, editor/history, galaxy, read-only chat, PWA and isolated
operator paths are implemented. Real provider quality, private migration,
production operation and physical-device acceptance remain open. It is not yet
release- or merge-ready.

Start with the [fictional demo](demo-start.md), then use the contracts and
verification map below. Historical implementation and CI details are retained in the pinned preceding
handoff linked under Current verification. This entry point keeps the current
contracts, reproducible start paths and explicit release limits.

## Architecture and data flow

### One content authority

Markdown, page revisions and durable mutation receipts live in snapshots of a
local bare Git repository, `.wiki.git`, inside the explicitly selected managed
vault. It is not a loose Markdown folder to edit directly. Browser, REST and
direct MCP use the same `WikiStore`; chat and indexes are not writers.

An absent publication ref is a healthy unborn wiki. A failed Git lookup alone
cannot establish absence: malformed loose/packed refs, dangling symbolic refs,
ref directories and abnormal Git exits are refused as `storage_unavailable`.
Page and graph reads and health return HTTP 503, empty setup refuses readiness,
and mutations cannot publish over that state. Valid packed-only refs remain
usable. These read-only probes do not repair corruption or replace full Git integrity checks.

Page saves require the page's `base_revision` and a stable `request_id`.
Publication uses a compare-and-swap ref update and includes the retry receipt in
the same snapshot. A page revision and the whole-wiki snapshot HEAD are different
values. A lost acknowledgement is resolved by replaying the **identical** request
ID and payload. Reusing an ID for changed content is refused; a revision conflict
requires a fresh read and deliberate reconciliation. A cancelled request can
already have published, so Cancel is not an undo operation. Subsequent index or
remote failure does not turn a published save into a lost write.

The two-tab [editor incarnation regression](../frontend/e2e/editor-incarnation.spec.ts)
covers deletion/recreation with identical Markdown, conflict recovery, retained
draft/selection and a fresh-read save. A historical retry receipt is a separate
contract: an unpublished draft cannot replay an earlier publication. These are
synthetic browser contracts, separate from physical devices and provider delivery.

### Derived retrieval and delivery

Exact page reads, lexical search, local history and explicit Markdown graph
navigation work without Neo4j, Qdrant or a model.
The lexical REST response is bounded to 50 results and reports `limit` and
`truncated`. A truncated result is not a complete match inventory; refine the
query to locate a specific page. The browser exposes that limit and refinement
hint. Semantic and graph-RAG modes keep their own provider contracts. Optional graph/vector adapters
build separate immutable generations and publish separate receipts for the exact
content revision, configuration and generation. Pending, stale, failed or missing
generations cannot be served as current. A lost provider generation requires
repair plus an explicit `--rebuild`; an unchanged local ready receipt alone does
not prove that provider storage exists.

The current derivation identity is `managed-snapshots-v37`, defined in
[index_config.py](../backend/src/second_brain/wiki/index_config.py).
This revision excludes simple inline SCRIPT islands from links and excerpts in
an explicitly bounded whole-document grammar. It accepts flat ASCII prose,
simple headings and restricted wikilinks, with exact ASCII-case SCRIPT pairs
optionally carrying one restricted double-quoted ASCII attribute. Their
single-line bodies contain no angle opener, entity, backtick or escape.
Multiple/unquoted attributes and unsupported syntax anywhere leave the entire
input unchanged; ordered-list
code, Unicode lookalike tags and complex HTML are explicit controls. This is
not general rawtext parity. Markdown, history, lexical source search and browser
rendering are unchanged. Both old provider receipts become pending at the same
content HEAD; failed builds remain unreadable. See
[bounded SCRIPT contract and local checks](flat-script-projection.md).

The preceding bounded emphasized-URL punctuation correction remains included.
A historical 336-case diagnostic reported 63 graph-target mismatches, but its
case-level corpus and rendered-target oracle are not present in the retained
evidence. That aggregate has not been reproduced in this review. Recover or
rebuild explicit synthetic counterexamples before extending this grammar;
complete Markdown/sanitizer/graph parity is not established.
An older identity invalidates both configured backend receipts. Rebuilding
changes derived data, not Markdown or history; configured vector rebuilding can
make paid embedding requests. Retention is explicit, dry-run first and scoped to
ledger-owned generations. Full snapshots/embeddings are materialized in memory;
the synthetic scale checks are not a production capacity claim.

The automatic delivery worker performs configured index work and outbound Git
publication. It does not silently pull, merge, force-push or adopt a changed
remote. Explicit import/pull APIs are separately guarded. Remote acknowledgements
are cached historical receipts, not assertions that a remote branch is still
current. Conflicts require reviewed local and remote heads. See
[delivery](managed-delivery.md), [Git sync](managed-git-sync.md) and
[index operations](managed-indexes.md).

### Browser experience

The bright wiki-first UI provides a browser-local saved start page with fallback,
direct URLs, search, safe Markdown/wikilinks, backlinks, history and a direct
editor. Navigation preserves deliberate keyboard focus and bounded tab-local
reading positions. Save/conflict/unknown-acknowledgement states retain the draft;
index and remote status are shown separately.

A valid mutation receipt confirms a historical publication. After each save the
editor separately reads the current page before closing. If another writer has
changed, deleted or recreated it, or that read fails validation, the same editor,
draft, selection, undo history, base revision and retry identity remain intact.
The notice distinguishes the confirmed save from the current-page problem.
**Cancel** deliberately discards the local draft and reads this visit afresh;
another Save of changed text still checks the original base rather than silently
rebasing over a concurrent writer. A write after the read can still make the
display stale; this is a snapshot check, not a lock on the page.

While a start-page transaction is pending, the control stays focusable with
`aria-disabled`; its handler rejects duplicate activation. Completion does not
steal a later focus choice or replace the editor.

The start-page choice uses its own versioned IndexedDB preference record;
success is shown only after transaction completion. Existing localStorage
choices import once when that record is absent. A denied legacy read leaves
migration pending, and an existing record always wins over stale legacy data.
Storage errors preserve the editor and allow retry. A delayed preference read
cannot redirect a newer navigation; a delayed Set retains the captured article
without placing feedback on another article. This is local to one browser
profile, not account sync or a guarantee against device loss or storage eviction.

The galaxy derives stars, curated constellations, cores and bridges from actual
page/link evidence. Missing or ambiguous targets remain explicit diagnostics.
Dense maps limit drawn incident edges without deleting API edges or directional
evidence. List/search/keyboard paths remain available. Article entry focuses the
matching current page or explains that it is missing from a stale snapshot.
Map/list changes preserve the selected page's expanded diagnostic; changing the
selected page starts fresh details. List and map layouts do not promise identical
inner scroll positions. Search updates highlights on the mounted map and reuses
identical result markup, preserving geometry and avoiding repeated layout work.

Markdown source, IDs and history are preserved. Rendered prose, safe HTML,
wikilinks and graph projection have separate regressions; the bounded parser
limits above still apply.

### Read-only chat and PWA

Chat uses server-side OpenRouter and bounded iterative search/page/neighbor tool
calls: eight calls and five rounds, explicit limits/errors and cancellation.
Only actually delivered page content counts as a read source. Long-page
continuation uses offsets and the expected page revision; changed snapshots
require reading again. Incomplete/truncated provider completion cannot become a
successful answer. Scripted providers verify contracts, not real answer quality.

Conversations are bounded, deletable browser-local data; there is no backend chat
archive or wiki-write tool. A versioned IndexedDB root stores conversations and
deletion markers. Each storage action reads, merges and writes in one native
transaction; only transaction completion confirms a save. Ordinary trimming
retains identity, while actual concurrent branches are preserved.

Legacy localStorage keys are imported only when the root is absent; an explicit
empty root prevents reimport. Those keys remain backups without dual writes;
current chat deletion does not erase those older copies. Failed commits can
retain changes across SPA navigation in the current document, but that fallback
does not survive reload. Unsent message drafts and the selected conversation
survive ordinary navigation away from Chat and back within the same document,
including Back/Forward. Draft text stays only in tab memory, outside IndexedDB
and legacy localStorage; a reload or closed tab can discard it. Returning reads
current saved messages and deletion markers before restoring drafts, so a
deleted conversation is not revived. Retained drafts also block PWA reloads
while another view is open. Credentials remain server-side.

The PWA is online-first. Its worker does not provide a private wiki/chat/API
offline cache. An update requires changed worker bytes, including a deliberate
`RELEASE` change; a frontend-only asset change does not create a waiting worker.
Updates protect each tab's unsaved editor/chat and pending requests from reload,
including when another tab activates the worker. Offline, quota, worker and provider failures are explicit.
Browser emulation and native Linux-WebKit are separate from installed mobile
apps, Safari, soft keyboards and screen readers.

### Authentication and compatibility

Managed REST lives under `/api/wiki`; direct managed MCP exposes ten tools and
`wiki://guidance`. Read guidance before editing. Missing-page `get_page` calls
return `isError:true` with matching structured/text JSON containing `not_found`,
a message and the requested ID. Existing-page reads and REST 404 are unchanged. The primary managed profile
excludes `remember/recall`; the optional
[legacy profile](legacy-memory-profile.md) remains isolated. Never point legacy
and managed writers at the same vault.

Private responses use `no-store`. The browser uses same-origin proxy
authentication; it does not receive the MCP Bearer key. MCP has a separate static
Bearer/Host/Origin boundary, not an OAuth server. Remote credentials require TLS.
Preserve and verify the actual authenticated proxy rather than exposing an
unkeyed upstream. See [MCP setup and network limits](managed-mcp.md).

## User and operator paths

A short fictional demo is Home → linked article/search → galaxy → chat with a
follow-up question when a real provider is configured. The atlas identifies its
pages as invented; public fixtures, logs and screenshots must contain no private
wiki content, conversation details or credentials.

For first start choose **empty**, **template** or **Git import** deliberately.
Nothing auto-seeds a nonempty vault. Restart the launcher to reopen later edits;
rerunning template setup instead verifies the original template and refuses
changed content. Interrupted seeding requires explicit `--resume` with the same
template; `--empty` is not recovery. The launcher refuses a symbolic-link vault
before resolution or writes, and empty setup verifies local Git health before
reporting readiness. This is not a guarantee against concurrent filesystem path
replacement or every ancestor symlink.

Import requires a clean, complete local Git working repository; shallow/partial
sources are refused. It flattens filenames into page IDs and refuses collisions.
An import replaces the **whole managed page set**; a source prefix is not a
partial destination update. Content bytes and source ancestry are retained,
including committed history outside the selected prefix. Review that history
before exporting or sharing a migrated vault. A filename inventory is not a
complete content/history/client migration audit.

Flat Markdown export preserves selected current bytes, not managed history or
retry receipts. It refuses IDs that cannot fit the destination filename-byte
limit rather than silently renaming them. Portable backup preserves managed Git
history and local ledgers, not credentials or external provider data. Restore is
create-only into a new path/volume. A concurrent save at bundle capture can
produce `backup_changed`; retry after the write rather than overwriting source.
A process-boundary save test does not establish power-loss or disk-failure
durability.

For Compose, retain the installation project name, environment, proxy aliases
and volume mapping. Record actual image IDs and archive current content before
an update. PR image builds do not publish deployable branch images. Do not use
`down --volumes` as an update or restore over the live vault. Inspect an independent
recovery before cutover; switching to an old image does not undo later edits.

| Task | Operational guide |
| --- | --- |
| Local demo, short tour and manual presentation | [Demo](demo-start.md) |
| Empty/template/Git choice and interrupted seed | [First start](first-start.md) |
| Private source selection, replacement and audit | [Import](wiki-import.md) |
| Content-only copy and filesystem limits | [Export](wiki-export.md) |
| Archive, concurrent save and create-only recovery | [Backup/restore](backup-restore.md) |
| Compose installation, image update and rollback boundaries | [Install/update](install-update.md) |
| MCP tools, editing guidance and auth | [Managed MCP](managed-mcp.md) |
| Optional indexes, delivery and remote credentials | [Indexes](managed-indexes.md), [delivery](managed-delivery.md), [Git](managed-git-sync.md) |
| Worker privacy, installation and updates | [PWA](pwa.md) |

## Reproduce the demo and checks

Use Linux or WSL, Python 3.12, Poetry 2.1.3, Git, Make and Node 20+. Managed
locking uses `fcntl`; atomic flat export requires Linux `renameat2`. Native
Windows has not been accepted. From a clean source checkout, remain at its root:

```sh
(cd backend && poetry sync --no-interaction)
(cd frontend && npm ci)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
export PYTHONPATH="$PWD/backend/src"
SECOND_BRAIN_WIKI_API_KEY= make demo PYTHON="$WIKI_PYTHON"
```

Open <http://127.0.0.1:5173>. This foreground launcher uses an isolated demo vault,
disables inherited hosted index/remote delivery targets and clears OpenRouter
access. The explicit empty API key is a loopback preview choice, not a change to
another installation's proxy password. Ctrl+C stops the services. Stop it before
running another profile on the same 8000/5173 ports. Do not use the older Make
`dev-start-infra`, `infra` or `prod` targets for this isolated preview; they can
operate on other containers.

The demo itself does not need Playwright browser binaries. To run the browser
checks below, install them separately after stopping the demo:

```sh
(cd frontend && npx playwright install --with-deps chromium webkit)
```

Run only checks relevant to the change; these commands are separate invocations:

| Check | Command from repository root | Boundary |
| --- | --- | --- |
| Backend lint/types/local tests and frontend types/build | `make check` | Excludes integration tests and legacy Git-sync test |
| Frontend proxy/access/PWA unit contracts | `(cd frontend && npm run test:proxy && npm run test:dev-security && npm run test:pwa)` | Additional to Make check |
| Real API/Vite and full Chromium | `SECOND_BRAIN_WIKI_API_KEY= make acceptance PYTHON="$WIKI_PYTHON"` | New fictional vault, no model |
| Empty start and actual service restart | `SECOND_BRAIN_WIKI_API_KEY= make acceptance-first-start PYTHON="$WIKI_PYTHON"` | Owned empty vault |
| Complete local synthetic Git import/retry | `SECOND_BRAIN_WIKI_API_KEY= make acceptance-import PYTHON="$WIKI_PYTHON"` | Three browser phases, source preservation |
| Synthetic320 graph/mutation/history | `SECOND_BRAIN_WIKI_API_KEY= make acceptance-scale PYTHON="$WIKI_PYTHON"` | Bounded dataset |
| Native WebKit reading/navigation | `SECOND_BRAIN_WIKI_API_KEY= "$WIKI_PYTHON" scripts/run-wiki-acceptance.py --browser-engine webkit` | Workers blocked |
| Native WebKit worker updates | `SECOND_BRAIN_WIKI_API_KEY= "$WIKI_PYTHON" scripts/run-wiki-acceptance.py --browser-engine webkit --webkit-workers` | Separate workers-allowed profile |

Docker Engine/Compose v2 are needed for
`SECOND_BRAIN_STACK_BROWSER=1 make acceptance-stack PYTHON="$WIKI_PYTHON"`.
The [stack guide](managed-stack-acceptance.md),
[index acceptance](managed-index-acceptance.md) and
[SSH acceptance](managed-ssh-acceptance.md) describe their explicit isolated
service/credential fixtures. A scripted failure, deterministic embedding or
loopback SSH key is not a real provider or production credential result.

The ordinary acceptance runner creates a fresh vault and isolated Playwright
output under `.demo/acceptance/`, then records revision, selected profile,
phase exit codes and cleanup. A successful run removes owned vault/phase inputs;
a failure retains them and its evidence. Never publish a retained vault or
browser storage receipt. CI allowlists synthetic screenshots, structural
attachments, logs and result records; originals expire after seven days.
A filtered/repeated diagnostic pass is not full-suite acceptance.

## Current verification, inspected 27 October 2026

Verified runtime/test head [831ac8a1](https://github.com/JonasKruegerCode/SecondBrain/commit/831ac8a131508e2f4aaf0c39f3d204a790fb9dff)
has tree `7736992036c341dfa009af2bb061aa7e79aa0cb7`.
It retains the bounded lexical-search response, completed fictional shore route
and corrected 23-edge galaxy assertion. Since the preceding handoff it also
includes two startup/recovery corrections:

- [b47013d2](https://github.com/JonasKruegerCode/SecondBrain/commit/b47013d2db471d8e6345a1a714039ae71cf2f887):
  SQLite backup reports `storage_unavailable` after ten seconds without copy
  progress under a busy/locked ledger, cleans the incomplete output and permits
  retry after release. The bound applies to stalled progress, not total backup
  duration. The 56 focused backup regressions include actual SQLite locks and a
  CLI timeout/retry; they do not establish off-host or power-loss recovery.
- [831ac8a1](https://github.com/JonasKruegerCode/SecondBrain/commit/831ac8a131508e2f4aaf0c39f3d204a790fb9dff):
  deeply nested invalid demo-marker JSON produces the existing friendly preflight
  error instead of a decoder traceback, including with `--empty`. The 32
  start-state cases include real CLI failures and unchanged vault bytes; service
  launches in those cases are test doubles.

This documentation refresh follows that head without changing runtime or tests.

All six workflows and nine jobs passed. The six completed workflow conclusions
were reconfirmed on 27 October; backend and browser original job logs were read:

| Domain | Original workflow | Inspected result |
| --- | --- | --- |
| Backend | [40465622660](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40465622660) | Ruff, Mypy over 137 source files; 1,539 passed, 12 separate integration skips, 28 subtests; image build succeeds |
| Frontend | [40465622588](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40465622588) | TypeScript, native contract tests, production and image builds |
| Indexes | [40465622671](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40465622671) | Disposable index integration succeeds |
| SSH | [40465622610](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40465622610) | Authenticated synthetic Git integration succeeds |
| Browser | [40465622544](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40465622544) | Seven acceptance phases succeed; no new archive download or screenshot inspection |
| Stack | [40465622661](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40465622661) | Managed stack and retained-image update jobs succeed |

The integration skips above are exercised separately, not waived acceptance.
PR image builds publish no application images.

### Directly inspected browser artifact: earlier head 102ea115

The hash/CRC and visual evidence below belongs to
[102ea115](https://github.com/JonasKruegerCode/SecondBrain/commit/102ea115f1d564fb0440d3bbbf7eff411dd2dfaa),
tree `d5c0d4a41700d5cd37d743260da905b33f58e889`, browser
[40418508809](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40418508809).
It is not a fresh archive or visual check of the later backup/marker corrections.

Browser artifact `12697899364` is 242,927,851 bytes with SHA-256
`5a5168887459d45f5871ce411628ce9d08cfd082186a231f68201a78d6128798`.
All 1,031 ZIP entries passed CRC checks. All seven result records report
`passed`, no failure, successful service cleanup, no retained vault and no
external model calls. The CI checkout `f6388288` has exactly the verified
branch tree; that generated test commit is not a merge authorization.
The original artifact expires on 2 November 2026 at 23:45 UTC.

Two galaxy overview screenshots from that archive at 390 and 1,440 pixels were inspected:
twelve fictional pages, 82 explicit links and four separated constellations.
The mobile card list is readable; bridge labels are denser in the small map.
Earlier search screenshots at 320/390/1,440 pixels were inspected only through
their upper 1,600 pixels; this does not establish every result card's rendering.
Earlier graph-mutation evidence remains historical, not a fresh comparison of
that archive. No physical device or real model was accepted by these runs.

The public atlas now completes the salt-marsh → shellfish-kitchen shore route
and consistently separates its tide model from real access observations.
Reuse the launcher for edited demos; template verification intentionally refuses
later edits. Use a fresh destination to try the revised template.

The [preceding pinned handoff](https://github.com/JonasKruegerCode/SecondBrain/blob/102ea115f1d564fb0440d3bbbf7eff411dd2dfaa/documentation/review-handoff.md)
preserves the earlier lifecycle, graph and recovery evidence with their original
scope. These are audit history, not parallel current counters. The open gates
and unresolved observations below still apply.

## Known release gates

- Real OpenRouter multi-turn answers with human inspection of the actual answers
  and read sources. `make acceptance-openrouter PYTHON="$WIKI_PYTHON"` requires an
  explicitly supplied server key and opts into paid calls against the fictional
  vault. Its result is structural and sets `answer_quality_reviewed:false`.
  Invocation counts do not measure HTTP retries or billing. Ordinary CI fake
  providers do not satisfy this gate.
- Hosted graph/vector/embedding configuration, retention and load. Full-snapshot
  builds and a bounded 320 fixture do not establish hosted capacity.
- Actual authenticated production proxy/HTTPS, reviewed published images and
  off-host restore. The disposable stack is independent evidence.
- Reviewed private Git credentials, full clean source/history audit and legacy
  client migration. Keep the previous deployment/vault available until accepted.
- Physical Android/iOS installation, standalone launch, touch, updates,
  soft-keyboard and screen-reader checks.
- Complete human presentation rehearsal: Home → articles → galaxy → a short real
  multi-turn chat, followed by an explicit review decision.

## Unresolved observations and practical limits

Later passing CI does not diagnose earlier intermittent failures. Preserve the
original assertion, gesture and timing when investigating a new occurrence.

- A native 390px modified-click sometimes failed to create an observable new page.
  A blank CDP target alone is not page arrival; isolated and subsequent full
  passes do not establish its cause.
- A WebKit first installation once showed an unexpected update notice after
  offline→online. Bounded event-order diagnostics did not reproduce the native
  failure; script-URL equality is not a first-install classification.
- An ordinary stack restart failed intermittently. The separate controlled
  backend-address/DNS-change gate demonstrates recovery, not its historical cause.
- A completed browser test run once failed cleanup with `ENOTEMPTY`; owned inputs
  also reappeared after reported deletion. Process/file metadata must be retained
  if it recurs; no product or environment cause is established.
- The earlier b1401d1 native WebKit chat input was focused but exceeded its
  viewport visibility limit. The cfa304e explicit reveal correction passed that
  unchanged limit; its synthetic preventScroll control does not isolate the
  older native scroll mechanism. The failed run remains failed.
- SIGKILL between child creation and receipt publication can leave an unrecorded
  process. Complete receipts allow cleanup of recorded groups; incomplete
  receipts do not guarantee shutdown. Resolve retained owned processes before
  rerunning on the same ports. This is not power-loss recovery.
- Renderer minimum-text-size, reduced-motion/forced-colors, SVG focus and
  touch-emulated checks have bounded coverage. Native font/glyph coverage,
  very dense maps, real devices and complete accessibility remain separate.

No merge, auto-merge, production cutover, private migration or deployment is
authorized by this document.

