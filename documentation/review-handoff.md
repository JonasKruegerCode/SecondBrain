# SecondBrain 2.0 review handoff

This is the current review entry point for the `secondbrain-2.0` branch.
[PR #18](https://github.com/JonasKruegerCode/SecondBrain/pull/18) remains **Draft**.
The managed wiki, editor/history, galaxy, read-only chat, PWA and isolated
operator paths are implemented. Real provider quality, private migration,
production operation and physical-device acceptance remain open. It is not yet
release- or merge-ready.

Start with the [fictional demo](demo-start.md), then use the contracts and
verification map below. The [previous handoff at 8203385](https://github.com/JonasKruegerCode/SecondBrain/blob/8203385cbb4ae5b65110d5e247299ae61f798de7/documentation/review-handoff.md)
preserves the earlier inspected matrices, original CI records and links to older
counterexamples. They are dated evidence, not claims about a later revision.
This document consolidates that history instead of accumulating run logs.

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
navigation work without Neo4j, Qdrant or a model. Optional graph/vector adapters
build separate immutable generations and publish separate receipts for the exact
content revision, configuration and generation. Pending, stale, failed or missing
generations cannot be served as current. A lost provider generation requires
repair plus an explicit `--rebuild`; an unchanged local ready receipt alone does
not prove that provider storage exists.

The current derivation identity is `managed-snapshots-v35`, defined in
[index_config.py](../backend/src/second_brain/wiki/index_config.py).
This revision removes phantom URL-path wikilinks from the bounded nested
single-star/strong note form when its ASCII words end in one `. ! ? , ; :`
character. Escaping, invalid closers and arbitrary nesting retain their existing
separate rules. The fixed 336-case diagnostic retains 63 graph-target mismatches;
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

## Inspected acceptance, 23 October 2026

Test/documentation source `8f9c2fc67bfe52cd9827dd7abe0ac0b2b706418c`, tree
`98171a3ccb16a4f9f03ce822b5ad9b0a8fb68d48`, was tested at merge
`a8ce7e9622595f140cbd9d898cbaa1754345599c`. Original checkout logs and
the Git object establish the identical tree. Application code is unchanged
from `8203385c`; the new test source adds the four native reload cases.
Subsequent handoff-only edits do not create another runtime acceptance result.

The documented synthetic tour was also exercised locally against source
`38cdb094` at 390/1440 pixels: Home → Mira Quill → archive method → field
notebook, lexical search, an editor save and history read, keyboard constellation
and page selection, explicit new-link evidence, and the unconfigured-chat path.
Send and Retry return real 503 responses, retain one submitted question and no
assistant answer; reload retains the question and deletion remains effective
after relaunching the same persistent browser profile. The start-page record was
read natively before app code after restart, and the edited article revisions
persisted. Each new link was checked in the graph before restart. All three
demo launcher shutdowns returned zero and their recorded
owned process groups were absent. Original screenshots at both widths were
personally inspected after waiting for the mounted galaxy; a separate viewport
capture distinguishes hidden skip-link geometry from a full-page capture
artifact. This uses cached dependencies and pinned partial source (146 matching
Git blobs, with only the old handoff excluded), not a fresh install, physical
device, model answer or complete release rehearsal. The no-key manual steps now
explicitly submit and retry a question before checking its local persistence.

Current Browser/Frontend originals cover the unsent-Chat-draft correction:
navigation and Back/Forward retain tab-only draft text and selected conversation, returning respects
current saved messages and deletions, and PWA reload protection remains active
while another view is open. The unchanged parent fails the three new draft
counterexamples. The corrected local selection passes 48 chat/concurrency/PWA
cases, separately from the complete CI below.

Native reload boundary, checked 23 October: four focused real Chromium cases
cover 390/1440 widths both in Chat and after switching to Search. Dismissing
the actual beforeunload dialog keeps the same document and unsent text;
accepting it creates a fresh document with no retained draft. Explicitly clearing
the draft releases the guard. No chat POST occurs, and draft text is absent
from the native IndexedDB chat root, chat localStorage keys and sessionStorage.
These are tab-memory checks, not persistent draft recovery or physical-device
proof. The initial harness incorrectly waited for a load event after cancellation
and timed out; triggering native location.reload for that path removes that
success-only wait. No application code changed for this check.
The strengthened cases also pass within the 89-case real-service Chromium
Chat/concurrency/PWA selection (1.8 minutes), with successful owned service
cleanup; both TypeScript projects pass. Cached native Chromium with the existing
runtime flags was used. All four new native reload cases now also pass in the
complete Chromium and reading-WebKit originals below. Current WebKit390/1440
captures after cancellation and returning from Search were personally viewed.
This is Linux-WebKit with reading-profile workers blocked, not physical Safari,
softkeyboard, installation or native-font parity.

| Area | Inspected original run / source | Result and boundary |
| --- | --- | --- |
| Browser | [39986025133](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39986025133), test source8f9c2fc6 |923 successful executions/14 explained phase-profile skips; all7 result records and owned cleanup pass |
| Frontend | [39968927737](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39968927737), current runtime |15 native cases/zero failures or skips; both TS projects, production and container builds; push:false/cache-only |
| Stack | [39959930051](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39959930051), [parent09eaac7a](https://github.com/JonasKruegerCode/SecondBrain/commit/09eaac7afee75ed2893db6adc10dfd4594df461b)/tree753a67c8 |109 gate records/107 distinct labels plus6 HTTPS/auth browser gates, real readonly foreign-owner Git import and edge cases; not a fresh Chat-runtime result |
| Backend | [39848542316](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542316), retained 9dafdc02 source |Earlier Ruff/MyPy125,1,458 passed/12 dedicated opt-in skips; not a new current-source audit |
| Indexes | [39848542236](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542236), retained 9dafdc02 source |Seven disposable Neo4j/Qdrant cases with synthetic vectors;320 pages/648 edges, not hosted capacity |
| SSH | [39848542360](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542360), retained 9dafdc02 source |Five isolated authenticated Git/restart/refusal-preservation cases, not production credentials |

Browser totals are 114 repeated WebKit transaction/preference diagnostics,
455 Chromium, first-start2, Git import3, synthetic320: 2, reading-WebKit339
and worker-WebKit8. Repetitions count as executions, not unique requirements.
Eight skips select complementary first-start/import phases; six are engine
exclusions in the WebKit reading profile. That profile blocks workers, while
the separate worker profile allows them. Dot reporting has no per-title JSON
ledger. The new four 390/1440 reload cases run in both broad engines; their original
WebKit captures were personally inspected. A viewport image does not establish
that every control fits the first screen or that physical soft keyboards work.

The retained parent Stack evidence checks EROFS and foreign UID rejection before
exact two-path Git trust inside a disposable setup container. Two imported pages
retain history, API edits, the original setup receipt and edit retries across
restart. Dirty and genuinely shallow clones fail with their specific errors
without changing the target head. An unborn Git source publishes a versioned
zero-page receipt, retries identically and refuses a competing first start;
the actual API list remains empty. All four source clones, including Git metadata,
remain byte-equal after owned cleanup. Those gates are not native suite case counts.

| Verified archive | Bytes / entries | SHA256 |
| --- | --- | --- |
| Current Browser12517117333 |229,377,206 /984 | `38f4dcb337cc02c7ed510f279697ef883d2596cab5a97388f032ee7a4410837a` |
| Retained Stack12504422063 |712,044 /6 | `f31141723a5fcf9f045d72184065c2fd2fad5ee74bce2a5306f4330998a50bde` |

Both archive checks match GitHub size/digest and safe unique-path/CRC checks.
Their originals expire 30 October 2026; links/hashes do not guarantee later
availability. Preserve needed evidence before expiry. Standalone image builds did not publish container images.

Earlier reader/coediting/operator paths and failed experiments remain in the
versioned handoff history. Later passes do not diagnose earlier loading,
preference, new-tab, worker-install or cleanup incidents. Synthetic TLS/providers,
Linux-WebKit and scripted tours remain separate from real model answer quality,
production operation, physical installation and human presentation.

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


