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
separate rules. A historical 336-case diagnostic reported 63 graph-target mismatches, but its
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

## Inspected acceptance, 24 October 2026

Current application source is [c42fc679](https://github.com/JonasKruegerCode/SecondBrain/commit/c42fc679341d281c299608257997bc1a99e4f317),
tree `ea6919a1dfac3bea662f65cdd5b8149e4e0119e8`. CI checkout merge
`2180c13d23107188e8ba9f5ec8d772a6a84104d0` has that same tree.
This documentation consolidation does not change application or test code.

The editor now separates a confirmed historical publication from the current
page. A subsequent GET must match both revision and Markdown before completing
the editor. Later edits, deletion/recreation, unavailable reads and malformed
reads retain the native textarea, draft, selection/undo, original base revision
and retry identity. Deliberate Cancel reads the current article. A changed draft
does not silently rebase onto another writer's version.

Twelve new real-service cases cover those paths at 390/1440 pixels, including
a concurrent writer before the first successful acknowledgement. Two cases fail
on the unchanged parent. The final local 50-case Save/conflict/body-timeout/
navigation/PWA selection, both TypeScript projects and production build pass.
A separate real CLI backup/restore with a second writer also preserves the same
document/editor and original retry at both widths; Cancel then reads the latest
article. Original views were personally inspected. Local checks use cached
minimal dependencies and partial source; the clean locked CI below is separate.

| Area | Inspected original run | Result and boundary |
| --- | --- | --- |
| Backend | [40026125273](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40026125273) | Ruff/Mypy, 1,476 passed, 12 opt-in integration skips; container build with push:false |
| Frontend | [40026125226](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40026125226) | 15 native tests, no failures/skips; both TS projects, production and container builds; push:false |
| Indexes | [40026125179](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40026125179) | Seven disposable Neo4j/Qdrant integrations with synthetic vectors |
| SSH | [40026125163](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40026125163) | Five isolated authenticated Git/restart/refusal-preservation integrations |
| Browser | [40026125184](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40026125184) | 947 passed executions, 14 explained phase/engine skips, no failure/flaky footers; all seven result records and owned cleanup pass |
| Stack | [40026125169](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/40026125169) | Both acceptance and image-update originals inspected; synthetic TLS/auth, real import/restart/recovery and retained-image compatibility |

The Backend skips are the separately successful seven index and five SSH cases.
Browser totals are 114 repeated WebKit transaction/preference diagnostics,
467 Chromium, first-start2, import3, synthetic320 graph2, reading-WebKit351 and
worker-WebKit8. These count executions, not unique requirements. Eight skips
select complementary first-start/import phases; six exclude five Blink-only
minimum-font cases and one Chromium CDP touch case from WebKit. Reading-WebKit
blocks workers; the separate worker profile allows them.

Both broad profiles include the twelve new editor cases without a selection
filter. Ten historical-receipt screenshots per engine corroborate the completed
suite; the two first-acknowledgement cases take no screenshots. Dot reporting has
no per-title assertion JSON. Current narrow/broad Chromium and WebKit originals
were personally viewed, including successor-edit, deletion and malformed-read
states. Native Linux engines and controlled HTTP errors are not physical-device,
Safari, dropped-TCP or real-model evidence.

Stack acceptance has 109 gate records/107 distinct labels plus six HTTPS/auth
browser gates, including real readonly foreign-owner Git import, dirty/shallow
refusals, empty Git import, restart/retry and independent-volume recovery.
Original source clones remain byte-equal after cleanup. These are gates, not
native suite test counts.

The separate image-update original retains distinct old/new image IDs and
checks baseline → forward → rollback → resume on one owned volume. History
counts are 1 → 2 → 3 → 3; REST/MCP retries add no extra publication. Its forward
browser trace observes changed worker bytes, retains the native draft when a
clean tab activates the update, then saves once and reloads. Preference migration,
empty private CacheStorage and zero page errors/model requests are recorded.
Browser evidence is forward-only; image rollback/resume cover content, history
and retry compatibility. Both jobs report successful owned cleanup.

| Verified current artifact | Bytes / entries | SHA256 |
| --- | --- | --- |
| Browser12533772700 |233,018,423 /1004 | `bc62b62894dc6be6120020cdc4ff1285d8bd747745a7c050a20751629e1d7ba5` |
| Stack12533011318 |712,247 /6 | `572688bf362f9aced35bfb39ddc2eed0d4a2a2c9fad4458f8c5252192d018c7a` |
| Image-update12533132777 |16,919 /3 | `32c8e108ef0cf0f0a450e0e80b2f6e1f65dd446e27f66b1884850ac65cd42a9b` |

All sizes/digests agree with GitHub metadata/upload originals; unique safe paths
and CRCs were checked. GitHub originals expire 30 October2026. Needed text
originals were preserved separately; links/hashes alone do not guarantee later
availability. No container image was published.

The [preceding handoff](https://github.com/JonasKruegerCode/SecondBrain/blob/c42fc679341d281c299608257997bc1a99e4f317/documentation/review-handoff.md)
preserves dated operator tours, reload checks, recovery probes, older CI matrices
and failed experiments. Later passes do not diagnose earlier intermittent
loading, preference, worker, new-tab or cleanup observations. Run only relevant
regressions after new changes; do not rerun full CI solely to refresh a date.

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


