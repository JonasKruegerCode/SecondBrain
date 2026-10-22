# SecondBrain 2.0 review handoff

This is the current review entry point for the `secondbrain-2.0` branch.
[PR #18](https://github.com/JonasKruegerCode/SecondBrain/pull/18) remains **Draft**.
The managed wiki, editor/history, galaxy, read-only chat, PWA and isolated
operator paths are implemented. Real provider quality, private migration,
production operation and physical-device acceptance remain open. It is not yet
release- or merge-ready.

Start with the [fictional demo](demo-start.md), then use the contracts and
verification map below. The
[full source and evidence history at f7da8a5](https://github.com/JonasKruegerCode/SecondBrain/blob/f7da8a519d4314a3950f6923d0e4c84ddd837cf5/documentation/review-handoff.md)
preserves detailed reproductions, historical failures and regression matrices.
It is historical evidence, not a claim about a later revision. This document
consolidates that material instead of accumulating another run log.

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
deletes and recreates a page with byteidentical Markdown before attempting the
old tab's first save. That save must conflict even before another tab changes
the replacement's content. A later UI save, repeated conflict, preserved draft
and textarea selection, rejected/accepted Cancel, fresh read and subsequent save
also verify recovery without changing the visit or adding conflict commits.
Historical retry receipts are a separate contract: this draft was never
previously published. Both 390/1440 cases passed locally with real API/Git
services and native headless Chromium 153; no content or response mocks. The
minimal local runtime is not the locked full suite, Linux-WebKit, a physical
device or a provider/index-delivery acceptance. Hosted results for these new
cases are included in both broad engine profiles of inspected Browser run
`39848542539` below. Headless synthetic acceptance remains separate from physical
devices, production operation and real providers.

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
separate rules; this is not complete Markdown-parser parity.
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
wikilinks and graph projection have separate regression coverage. The v26 bounded
760-context Marked comparison improves 123 mismatches to 54 without a new mismatch
in that matrix. Escapes, mixed delimiters and HTML-anchor contexts still limit
general parity; do not claim complete Marked/sanitizer/graph equivalence or an
absence of all phantom-link cases.

A literal star before the bounded single-star URL/trailing-strong form now
keeps the external URL out of the wiki graph, matching rendered articles.
The correction covers an extra unescaped or escaped opening star; it does
not implement a general delimiter-run resolver. Earlier bounded corrections left 92 and then 72 graph-target mismatches in a
fixed 336-case diagnostic. The current v35 terminal-punctuation correction
leaves 63; these are successive source revisions, not complete parser parity.
Raw Markdown, page revisions and Git history are preserved. The derivation
identity change makes older index receipts pending; rebuilding configured
embeddings can make paid requests and remains an explicit operation.

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
does not survive reload. An unsent draft is not promised to survive reload or
route changes. Credentials remain server-side.

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
(cd frontend && npm ci && npx playwright install --with-deps chromium webkit)
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

## Inspected acceptance, 22 October 2026

Functional source `9dafdc021ad7aa5fda2dd45410eecc2cef39ceef`, tree
`684b9d9ad44d698fe9dc46b04f3914d5e86077a8`, was checked at merge
`e1deab8e67b9e4ccaaf505e7867a6c9370c4bee8`. Original checkout logs and
the Git object establish the same tree and ordered parents main `1f0cd1e7`
plus functional source `9dafdc02`. Subsequent documentation-only changes do
not constitute another runtime acceptance result.

| Area | Inspected original run | Result and boundary |
| --- | --- | --- |
| Backend | [39848542316](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542316) | Ruff/MyPy125; 1,458 passed, 12 dedicated opt-in skips; image build |
| Frontend | [39848542554](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542554) | Both TS projects; proxy5/access2/PWA5/image-protocol2; compile and image build |
| Indexes | [39848542236](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542236) | Seven real disposable Neo4j/Qdrant cases with synthetic vectors; 320 pages/648 edges |
| SSH | [39848542360](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542360) | Five authenticated Git/restart and host/agent refusal-preservation cases |
| Browser | [39848542539](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542539) | Seven passed records; 858 successful executions/14 explained skips, zero reported failed/flaky |
| Stack | [39848542400](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39848542400) | 87 gate records/85 unique labels, six synthetic TLS/auth/browser gates, 49 retained-image gate records |

Browser phase totals are WebKit transaction/preference diagnostics114,
Chromium422, first-start2, Git import3, synthetic320:2, reading-WebKit307
and worker-WebKit8. Repetitions count as executions, not distinct requirements.
Eight skips select complementary first-start/import phases; five exclude
Blink-only minimum-font checks and one excludes CDP-only touch. The reading
WebKit profile blocks workers; the separate eight worker tests allow them.
All seven Git-import preservation/retry assertions pass. Original result records
assert zero exit codes and owned runner cleanup; these are not OS-wide or
power-loss guarantees. No external model was called.

The missing-page MCP error correction is covered by direct, HTTP and real SDK
stdio tests. Two preceding backend attempts remain failed:
[39847387889](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39847387889)
caught the new test's SDK union typing before pytest;
[39847652692](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39847652692)
passed Ruff/MyPy and 1,457 cases but exposed an old stdio assertion expecting
the incorrect success flag. The final source narrows the SDK types and corrects
that assertion. The earlier 21 October editor-focus failures and Optional-page
test error remain in Git and the pinned historical handoff; later passes do not
relabel them or establish causes for unrelated intermittent observations.

Standalone image jobs use `push:false/load:false` and cache-only output.
The separate stack actually builds and runs images. Its normal path verifies
synthetic TLS/auth, same-origin writes, shared REST/MCP, isolated chat cancellation,
DNS/IP churn without restarting the frontend, and create-only restore on a separate
owned volume. The retained old/new/old/resume path uses distinct real images on
one volume, history 1→2→3→3, changed worker bytes, retained native editor,
one browser save/history addition and preference migration. Scripted providers,
synthetic TLS/SPKI and disposable volumes do not establish production operation.

All listed archives match API sizes/digests and pass safe unique-path/CRC checks:

| Artifact | Bytes / entries | SHA256 |
| --- | --- | --- |
| Browser12458460505 | 217,826,510 / 934 | `4e65d0943bc03aab6a8321a54428649af08d21fe65dd0952d1daf2f166ef8f59` |
| Stack12457825223 | 709,107 / 6 | `60c767144526af6b342b6a5e3df450008d6ef18da47e6a7d436f3dcfed6de7e9` |
| Image-update12456696346 | 16,714 / 3 | `c10d9741b25efa843bf96ce5fede603bbbd54e650d1ec9d8d6ce08ae4ded2359` |

These workflow artifacts expire 29 October 2026; references and hashes do not
guarantee availability afterward. Preserve needed evidence before expiry.
Selected captures were visually inspected; 934 entries do not mean 934 images
were individually reviewed. Full-page captures do not establish first-screen
visibility.

### Current graph derivation and parser boundary

The current identity is **managed-snapshots-v35**. The bounded nested
single-star/strong handling accepts ASCII words with one terminal
`. ! ? , ; :` character while retaining escape, closing and flanking guards.
For example, `*HTTPS://example.test/[[target]] **Field note.***` renders an
external article link without inventing a wiki edge to `target`.
The fixed 336-case diagnostic still has 63 graph-target mismatches; arbitrary
nesting and general Markdown parity remain outside this correction.
Markdown, revisions and history are unchanged. Older configured index receipts
become pending; explicit rebuilding can make paid embedding calls.

### Independent synthetic reader paths

A real Chromium reader walk at 320/1440 completed Home → curated article → search
→ Galaxy selection/zoom/list → article → Chat. The unconfigured chat correctly
returned 503, retained the question and offered Retry; no model answer was claimed.
A separate real browser/MCP HTTP coediting path at 390/1440 preserved drafts
through foreign saves, deletion/recreation and two 409 conflicts, then deliberately
reloaded and saved the current page. Both clients agreed on revision/history 5
and graph links. It used cached native Chromium with nondefault runtime flags
and blocked workers, not the locked CI environment or a physical device.

The first coediting fixture attempt passed 390px but its reused browser closed
before 1440px. Separate browser instances passed both widths. This is a local
fixture correction, not an established product cause. Immediate owned-group/input
cleanup was recorded, but operational files later reappeared; the cause remains
unknown and lasting absence is not established.

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

