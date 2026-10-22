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

## Pending start preference and keyboard focus

The start-page control remains focusable while its IndexedDB transaction is
pending. `aria-disabled` announces the temporary lock and the click-handler
guard rejects duplicate activation. A native `disabled` button lost focus in
the prior asynchronous implementation, including when an unrelated Save
request later failed. Completion updates the current toolbar without restoring
focus over a later user choice or replacing the editor. Both browser-engine
suite contracts include the start-preference regressions.

The 21 October CI on `3706165` preserved this counterexample: Chromium had
379 passes and 20 editor focus failures; the backend had 1,373 passes, six
outdated suite-list expectations and 12 explicit opt-in skips. Later browser
phases, including broad WebKit, were skipped. These are failed runs, separate
from the previously accepted parent and subsequent correction evidence.

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
cases must be checked separately.

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
not implement a general delimiter-run resolver. A fixed 336-case diagnostic
improves 92 graph-target mismatches to 72 with no new mismatch in that matrix.
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
`wiki://guidance`. Read guidance before editing. The primary managed profile
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

## Historical development evidence, inspected 21 October 2026

Implementation `f7da8a519d4314a3950f6923d0e4c84ddd837cf5`, tree
`561baa8481b86664b4b9f552d7df393eb9044e65`, was tested at merge
`1fac0cbcf93f2f1fe281ccf79e328a5ed80f9907`. The merge has that identical tree
and ordered parents main `1f0cd1e7` + implementation `f7da8a5`.
The logs and downloaded result records below were inspected, rather than
inferring acceptance from workflow badges. This handoff consolidation changes
only documentation; it does not create another runtime acceptance result.

| Area | Examined run | Result and scope |
| --- | --- | --- |
| Frontend | [39508028891](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39508028891) | Both TypeScript configurations, proxy 5/access 2/PWA 5, production and image builds |
| Backend | [39508028925](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39508028925) | Ruff/MyPy on 124 files, 1,377 passed/12 opt-in skips, image build |
| SSH | [39508028842](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39508028842) | Five native isolated SSH/Git cases |
| Indexes | [39508028961](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39508028961) | Seven disposable provider cases with synthetic vectors; together with SSH exercises the 12 ordinary-suite opt-ins |
| Browser | [39508028858](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39508028858) | Seven passed records/ten zero-exit phases; 681 successful executions including 33 repeated diagnostics, 14 skip occurrences |
| Stack | [39508028782](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39508028782) | 78 gate entries/76 unique, six built-browser gates, synthetic HTTPS/auth, independent 14-page restore |

Both image logs show `push:false/load:false` and cleanup. No image was published.
Browser phases contain native WebKit storage diagnostics 33, broad Chromium 374,
first-start 2, Git import 3, scale 2, broad Linux WebKit 259 and worker updates 8.
The broad profiles have no grep/repeat relaxation; diagnostics and worker profiles
retain explicit selections. The 14 skips are eight complementary first-start/import
phase selections and six known engine exclusions, not unexplained missing cases.
The new trailing-strong 320/1440 cases run in both broad engines. Their four actual
full-page images were personally inspected for readable wrapping.

Stack logs show removal of both isolated projects' containers, networks and volumes.
The controlled DNS test changes backend address `.3` to `.6` while retaining the
frontend. Docker health remains `starting` in both diagnostic snapshots despite
the passing HTTP-health gates. Proxy logs show the disconnected 499 and survivor/
retry 200 responses; exact bodies, no-store and completed invocations are runner
assertions. The restored page count is an explicit 14-page runner assertion.
Cleanup, retention and no-model statements are records/logs, not independent
OS or network tracing.

Downloaded archives were size/hash/CRC and safe-path checked:

| Artifact | Bytes / regular entries | SHA256 |
| --- | --- | --- |
| Browser 12305261215 | 204,779,355 / 844 | `d89ae394c06740f6b2ba1a3ed57469fd81fbe11b2f4e4ee8538356774b6dd60a` |
| Stack 12304511916 | 706,527 / 6 | `959825a1c059aefb71538b2710f8b987e23b1fe1b56966d59f38d90abb842932` |

Original CI artifacts expire 27 October 2026; links and hashes do not guarantee
availability afterward. Historical failures remain in the pinned handoff and Git
history, including Backend39499565295's Optional-page test error before pytest
and the unsuccessful Web Lock storage attempt. A later green run does not explain
an earlier intermittent failure or turn phase executions into unique requirements.

### Current graph derivation and parser boundary

The latest bounded correction recognizes one trailing strong segment of ASCII
words inside outer single-star URL emphasis. For example,
`*HTTPS://example.test/[[target]] **Field note***` is an external article link;
the graph must not invent a wiki edge to `target`. Existing simple matching and
code/anchor/escape/closing/flanking guards are retained. Markdown, history and
API payloads were unchanged. That correction used derivation identity **v33**: older
configured receipts, including v32, become pending until rebuilt. A configured
embedding rebuild can incur provider costs; this is not an automatic production
rebuild or content migration.

Both actual parent browser probes fail at the phantom edge. The corrected local
selection passes 615 Python cases and all 48 article/code-reading cases, including
UI Save, reload, backlinks and history. Ruff, MyPy on all four changed Python files
and both TypeScript configurations pass. A bounded 336-case Marked12 diagnostic
corrected 16 mismatches without a new one, retaining 92 other differences at that
revision; the later literal-star correction above leaves 72. The prior
259-case escaped-punctuation matrix has zero mismatches. Arbitrary nesting,
Unicode/punctuation inside that strong segment and malformed delimiter spacing
remain outside this correction. These matrices do not establish complete Markdown
parity. Earlier source/title, escaped-opener and inline-HTML corrections and their
counterfactuals remain available in the pinned history.

### Independent synthetic reader walk

At 320×900 and 1440×900, a fresh real Chromium walk completed Home → curated
article → search → article → Galaxy cluster/page selection → zoom/list → Open
article → Chat against genuine content/index services. No document horizontal
overflow or browser page error was observed. The narrow map truncates a long node
title; the selected heading, evidence and Open article remain usable. Actual
viewport and separately labeled full-page captures were inspected. A full-page
image does not establish first-screen visibility.

Chat returned the real not-configured 503, retained the question and offered Retry.
No provider was mocked and no model call or answer-quality claim follows. Owned
services terminated and the ephemeral vault was removed. This local walk and
Linux WebKit CI do not establish physical installation, Safari/iOS, native zoom,
production operation or private migration acceptance.


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
