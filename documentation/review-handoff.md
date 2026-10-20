# SecondBrain 2.0 review handoff

This is the current review entry point for the `secondbrain-2.0` branch.
[PR #18](https://github.com/JonasKruegerCode/SecondBrain/pull/18) remains **Draft**.
The managed wiki, editor/history, galaxy, read-only chat, PWA and isolated
operator paths are implemented. Real provider quality, private migration,
production operation and physical-device acceptance remain open. It is not yet
release- or merge-ready.

Start with the [fictional demo](demo-start.md), then use the contracts and
verification map below. The
[full earlier handoff at 2a0b4fd](https://github.com/JonasKruegerCode/SecondBrain/blob/2a0b4fd3f16c0d9548de2d10945feaeaf03eb9cd/documentation/review-handoff.md)
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

### Derived retrieval and delivery

Exact page reads, lexical search, local history and explicit Markdown graph
navigation work without Neo4j, Qdrant or a model. Optional graph/vector adapters
build separate immutable generations and publish separate receipts for the exact
content revision, configuration and generation. Pending, stale, failed or missing
generations cannot be served as current. A lost provider generation requires
repair plus an explicit `--rebuild`; an unchanged local ready receipt alone does
not prove that provider storage exists.

The current derivation identity is `managed-snapshots-v30`, defined in
[index_config.py](../backend/src/second_brain/wiki/index_config.py).
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

### Read-only chat and PWA

Chat uses server-side OpenRouter and bounded iterative search/page/neighbor tool
calls: eight calls and five rounds, explicit limits/errors and cancellation.
Only actually delivered page content counts as a read source. Long-page
continuation uses offsets and the expected page revision; changed snapshots
require reading again. Incomplete/truncated provider completion cannot become a
successful answer. Scripted providers verify contracts, not real answer quality.

Conversations are bounded, deletable browser-local data; there is no backend chat
archive or wiki-write tool. Ordinary trimming retains identity, while actual
concurrent branches are preserved. Browser storage is not a transactional
multiwriter database. An unsent draft is not promised to survive reload or route
changes. Credentials remain server-side.

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

## Evidence snapshot

### Indented ATX title identity (20 October)

A real top-level H1 with one to three leading spaces now supplies the same
article title to REST/MCP reads, search, title resolution, graph metadata and the
browser. Empty H1s cannot consume a following line or block promotion of a later
nonempty title. Separators after the hash are horizontal ASCII whitespace.
List subtrees are excluded only from title projection: their two-space prefix
must not make a nested heading look top-level. Quote/code/HTML/table boundaries,
source bytes, page IDs and Git history remain protected. This is bounded ATX
alignment, not complete Markdown parser parity.

Identity v30 makes previous configured index receipts pending until rebuilt;
a configured vector rebuild may call the embedding provider. No content migration
or automatic production rebuild is performed by this change. Existing v29 receipts
are explicitly covered along with older identities.

Local validation uses the actual built client and managed API, with synthetic
pages only. Six indented-title browser cases fail on d02fe06 while two unindented
comparators pass. Two additional empty-heading cases fail on the intermediate
frontend; the final predicate skips whitespace-only candidates. All **62** selected
Chromium code-reading/title-identity/title-inline/title-promotion cases pass on the
final source, including UI Save/reload, source/history assertions, TOC/fragment
focus and container protection. Both TypeScript configurations and Vite build
pass. Two new three-space-title images at320/1440 were personally inspected;
services and the owned vault were removed.

Backend validation covers **523 distinct local cases** across the selected wiki
modules:495 synchronous projection/store/index cases, two async MCP cases rerun
with the configured asyncio mode, and26 API cases. An initial harness override
omitted asyncio auto mode; those two async failures were invocation failures,
not accepted product results. Ruff passes; MyPy passes for the two changed runtime
modules using the backend configuration. The title matrix also has67 failures
against the parent and20 passes, including the expected v29 receipt mismatch.
Cached dependencies were restored to repository-locked MCP/Qdrant/telemetry
versions where needed; this is not a fresh full lock installation. A known
Pydantic forward-reference warning and the legacy bundle-size warning remain.
Current-head hosted regression and WebKit remain pending; the parent's complete
hosted acceptance is separate. No real model, private migration, production or
physical-device acceptance follows.

### Leading source preservation (d02fe06 parent, 20 October)

The reader no longer removes the first line of indented code as though it were
an article title, or consumes the remaining article after a CR-only title line.
Only a line-bounded ATX candidate confirmed by the existing title projection is
removed. Unconfirmed headings remain in the article body; normal leading titles
retain their existing section numbering. This does not expand backend title
recognition or promise complete Markdown parity.

Opening the editor now assigns its value after DOM construction. HTML textarea
parsing otherwise discards one leading newline; stored source bytes remain exact
until an explicit textarea edit publishes its normalized LF contents.
Fourteen new built-client/API cases at 320/1440px failed on the parent: indented
code (spaces, tab and mixed indentation), CR-only article text, leading LF/CRLF
editor blanks and an unconfirmed indented H1. They pass with the correction,
including exact source reads, actual UI Save, reload, history2 and no horizontal
overflow. All 54 local code-reading/title-identity/title-inline/title-promotion cases,
both TypeScript configurations and the production build passed. Four new
viewport images were personally inspected; services and the test vault were
removed. These checks remain separate from subsequent hosted acceptance. Fixtures are synthetic, workers
blocked and Chromium native to the execution host; no physical-device, real-model
or production acceptance follows. An early test draft incorrectly expected the
backend to title a three-space-indented H1; the final regression instead preserves
its existing ID fallback and asserts that the real heading remains visible.

### Mixed emphasis URL scopes (20 October)

Backend projection now recognizes a leading URL in a bounded simple emphasis
scope at its source position, including surrounding independent markup and
plain prose after the URL. It preserves delimiter flanking, Unicode/JavaScript
whitespace, raw link/backtick/angle masking, code/HTML-anchor shielding and the distinction
between an uppercase URL at a token start and one embedded after prose. Markdown
source/history and rendering remain unchanged. Index identity v29 invalidates old
ready receipts; configured embedding rebuilds can incur provider costs.

The selected Marked12 matrix is a bounded comparison, not a complete inline
parser or arbitrary nested-emphasis guarantee. Escaped delimiters and other
previously documented mismatches remain outside the supported scope. The new
built-app 320/1440 regression checks visible links against graph/backlinks, exact
source reads, normalized textarea contents, real UI Save, reload and history.
CRLF remains exact until the explicit textarea edit publishes its LF draft.
A later literal-angle counterexample extends the guard to the renderer's full raw
link/backtick/angle mask. Four new red cases precede that correction. Identityv29
also invalidates the intermediatev28 receipts.
The parent browser failed both graph assertions; the corrected cases pass.
Local backend selection430 cases, scoped MyPy over four files, source/test
Ruff/format, both TypeScript configurations and Vite production build passed.
An attempted broader local API/MCP/index collection was blocked by the retained
minimal environment (missing instrumentation/Qdrant and MCP2 versus project
MCP1), so it supplies no API/MCP/provider acceptance. Hosted locked checks are
still required. An extended independent292-case Marked comparison found zero new mismatches
in that bounded matrix; existing delimiter/escape mismatches remain.
Twelve isolated complexity samples on intermediate ce4a1ee, before the final
literal-angle guard (unclosed prose, many short scopes, raw escaped-backtick
pairs), up to950033 bytes completed below0.450s; single samples,
not a general parser, API latency or capacity bound.


### Previous output-preserving projection optimization (7602e6b)

Long URL punctuation/closing-parenthesis suffixes previously caused repeated
whole-prefix regex work; repeated comments copied the remaining source suffix.
The parser now removes eventual URL suffixes in one backward pass (preserving
the entity-sensitive `&name;` boundary) and scans comment tokens by absolute
position. Content, source bytes, graph syntax and the v27 index contract are
intended to remain unchanged. This is a backend projection optimization, not a
replacement for Marked or a browser rendering complexity guarantee.

Synthetic operation-count regressions cover URL suffixes and original-string
comment searches; source/history/backlink tests preserve intentional mutations.
Selected local projection regressions passed398 cases. Independent comparisons
matched80000 comment-state and30000 URL cases against the previous parser; an
additional20000 URL cases matched the installed Marked12 tokenizer. Isolated
four-second probes that previously timed out completed at262KB in about0.109s
(periods) /0.068s (parentheses), and at1MB in about0.131s (short comments),0.085s
(ordinary comments after whitespace) and0.482s (mixed punctuation). These are
single local samples, not capacity guarantees or complete parser equivalence.
No derived-index identity bump is required for this output-preserving change.
The browser regression uses ordinary-size synthetic source, real API mutations,
editor read/cancel, reload, backlinks and history at320/1440px; it does not claim
fast browser rendering of a one-megabyte URL or a new UI-save acceptance result.

**Inline HTML metadata and graph agreement, 20 October 2026:**
A real source such as `See <a href="https://example.test/docs"
title="[[setup]]">documentation</a>` created an invisible graph edge:
Marked12 consumes the attribute as HTML metadata and the sanitizer drops it.
Valid inline tag tokens are now masked in derived link/excerpt prose; visible
body wikilinks remain navigable. The grammar keeps JavaScript's ASCII names and
whitespace rules. CR/CRLF normalization replaces Python's broader splitlines
behavior so control characters cannot manufacture valid tags. Original Markdown,
IDs, revisions, history, renderer and mutation contracts are unchanged.

The earlier 21-case red run had15 actual failures on the parent store.
The final regression contains25 Marked-compared inline cases plus native
Git/source/history/backlink coverage. Independent review caught a draft Unicode
name mismatch and checked the final25 cases against installed Marked12.
Two draft expectations for unquoted control characters were corrected only after
both native implementations agreed; those draft failures are not product fixes.
This is bounded token coverage, not general Markdown/parser parity.

Local selected verification:422 synchronous backend cases passed across link,
code, comment, HTML, title, snapshot, index and REST checks, plus two async MCP/
coordinator checks under the project's async mode. The latter initially did not
execute when a local CLI override dropped `asyncio-mode=auto`; rerunning those
two with the project mode passed. Ruff/format and MyPy for the changed modules,
frontend application/E2E TypeScript configurations on the selected source
snapshot and Vite production build passed. This reused the available development
environment, not a fresh full lock/environment installation.

Two committed reading cases at320/1440px passed against real built assets/API
and an isolated fictional320-page vault. They compare visible links, graph,
missing targets, backlinks, reload, exact editor bytes, a deliberate later link
and two-entry history. Viewport images were personally inspected; the owned
supervisor exited and fixture vault was absent afterward. Local Chromium153
with workers blocked is not new WebKit, provider, hosted-index, production,
physical-device or screen-reader acceptance. Existing full/WebKit profile
selection already includes `code-reading.spec.ts`; hosted results for this
change remain pending.

Derived index identity advances fromv26 tov27 so an old ready receipt cannot
advertise the previous projection as current. Rebuild may invoke configured
embedding providers; no Markdown migration or automatic production deployment.
The six accepted hosted CI areas on parentcab3e7d remain parent evidence,
not results for this new change.


**Save feedback at the viewport edge, 19 October 2026:**
Hosted Browser39310367572 on 1546d6c/test merge366bd989 actually failed:
Chromium310 passed/four failed, all four desktop pointer/keyboard
transport/conflict cases clipped the notice (viewport ratios0.7847/0.3923).
First-start/import/scale/WebKit/worker steps were skipped. The failed CI cases
stopped before their screenshot line; four error contexts are evidence, not
failed-case screenshots. Artifact12216975182:112,286,951bytes/SHA256
`f915eebf27191061b98a760f09453cae1777cf8dd833a84415ed0a6249be3116`,
API/upload/download match and416 safe unique paths/CRCs checked. The result
records service cleanup and retained failed inputs; those vault/process inputs
are not in the uploaded archive. Original artifact expiry is26 October.

A real pre-Save wheel gesture places the visible button near the desktop bottom
edge. Four unchanged strict visibility assertions fail on1546d6c; a captured
conflict failure shows notice y825–865.8 in an844px viewport. Error restoration
now reveals the editor footer only while restoring Save-owned focus. A12px
scroll margin avoids fractional-pixel clipping by integer scroll rounding.
A later deliberately focused control keeps its focus and scroll; this is not a
general manual-scroll-intent guarantee. No API/storage/index contract changes.
The same textarea, atomic status, draft/selection/undo and retry identity remain.

The existing matrix retains its twelve small/narrow/desktop cases and adds four
bottom-edge cases, with two delayed-preference cases unchanged. Pre-assertion
viewport captures and rectangle diagnostics now preserve pixels on failure.
No post-Save test reveal, ratio/timeout/gesture relaxation or profile expansion.
Both existing Chromium/full and WebKit/reading registrations select this file.

Final local Chromium regression20261019T202128Z passed31 selected Save,
pending-preference, unknown-result retry, conflict, scrolled-draft and unavailable
status cases; both TypeScript configurations and production build passed.
Actual desktop bottom-edge and320px viewport images were personally inspected.
An intermediate JS-only run remains failed84/87: two fractional-pixel cases
motivated the margin; a separate Git-delivery case exhausted30s during its
first graph control read, after the local save and before recovery. One isolated
unchanged1440px delivery retry20261019T202419Z passed. That does not explain or
erase the original deadline failure; no general infrastructure cause established.

Fresh built-assets/real-API Chromium153 also passed actual CDP offline-before-POST
and manual reconnect/retry on a fictional320-page/648-link vault at1440×844,
with150ms latency parameter,200,000/93,750B/s and4xCPU emulation. A pre-Save
wheel gesture and strict final geometry show visible notice and Save; the same
editor/draft and an independent unchanged-source read precede identical request
ID/payload retry, exactly one content commit and history2→3. Worker/provider/
remote delivery were disabled. The owned supervisor exited and vault was absent
at completion. These local checks do not certify the new hosted full/WebKit
matrix, physical installation, screen-reader announcements or real-model quality.

**Browser-suite registration, 19 October 2026 (base 2a0b528):**
The f989da7 archive showed that explicit Chromium/full and WebKit/reading lists
omitted `galaxy-search.spec.ts`. Both corrected profiles select it once without
grep/repeat filters. Actual logs and archive records at test merge 43a7069
(identical tree and verified main+head parents) now pass Chromium 300, WebKit
reading 185, first-start 2, Git-import 3, scale 2 and workers 8: 500 successful
phase executions/14 skips. Four new search screenshots and selection records
support those cases; the dot reporter gives aggregate totals, not named case
verdicts. All six CI areas were inspected, including logs and stack/browser
archives. This certifies the stated base revision, not later UI changes.
Browser artifact 12207302363 SHA256
`d5895479844c552ea9191b25120ad65cce77cb3e80cd3244bd40180e4b551422`:
186,998,268 bytes, 748 safe unique regular paths/CRCs and API/upload digest
checked, all six result records/cleanup accepted, no model calls. Narrow WebKit
and desktop Chromium search images were personally inspected. Original artifacts
expire 26 October; hashes do not guarantee availability after expiry. The new
Save feedback change needs its own current-head hosted evidence.

**Galaxy search rendering, 19 October 2026:**
Trusted sequential typing in a real synthetic 320-page/648-link wiki exposed
repeated SVG reconstruction and identical result-list replacement. Search now
updates existing star classes and only replaces changed result markup. Selection
still rebuilds its actual neighborhood and fresh link diagnostics. Two browser
regressions at 390/1440px check SVG identity, viewBox/positions, exact search and
selection highlights, focus, clearing, a different result selection, unchanged
result controls and unchanged server revision. The selected 390px identity case
failed before correction; both pass afterward against built assets and real API.
The final built-assets run passes all 21 related article/galaxy browser cases on
the isolated fictional demo (12 seeded pages, with extra owned test pages where
needed). Both TypeScript configurations, production build and independent
review pass. The f989da7 hosted evidence below passes its selected suites but
does not include the two new cases; registration is corrected above.

The bounded built-asset probe used Chromium153, Vite preview with the real API
proxy, no HMR, no worker/provider calls and no network throttling. Each of three
profiles (390/1440px native CPU and 390px emulated 4x CPU) had three navigations
and typed `scale-0319` at 50ms between keys.
At 390px with emulated 4x CPU, all 30 keypresses were reported by Event Timing:
observed median duration was 144ms before and 32ms after; maximum 264/176ms.
This small sequential comparison is not INP, a controlled benchmark, a physical
device result or a deployed Nginx/auth/HTTPS measurement. Native-width event
entries below the 16ms observation threshold are missing, not zero. Initial list
creation and occasional long tasks remain; no general capacity claim follows.
Narrow/desktop screenshots were personally inspected. A separate final-probe
attempt timed out expecting eight cluster buttons (zero observed); a diagnostic
repeat passed without timeout changes, but the first failure's cause is not
isolated. Do not erase it or infer that timing variability is solved.

**Previous UI correction:**
A failed sync-status request no longer claims that saved content is safe locally.
The browser states that local storage and remote delivery could not be verified.
A native malformed-ref outage reproduced the old assurance at 390/1440px; after
correction the same real-service paths preserve the draft and editor and recover
when the ref is restored. Cold article retry also recovers without changing the
content head. Four response/transport-injected browser regressions cover both
widths, keyboard focus, same editor, unchanged server content/revision and real
status retry. The selected storage390 case failed before correction; all four
pass afterward. Both TypeScript configurations, production build and independent
review pass. These local checks are not a new full browser or device acceptance.

**Publication-ref correction:**
[Publication-ref regressions](../backend/tests/test_wiki_ref_readiness.py) reproduce
seven damaged-ref states that previously appeared empty. Twelve cases now pass
with native Git 2.51.1 and 2.43.0, including healthy unborn/packed-only controls;
abnormal process exits and inaccessible-path errors use explicit injections.
The related store/API/setup suite passes 82 cases. The full ordinary local
backend suite, Ruff and MyPy (118 files) pass. API failures preserve existing
storage after app initialization. Independent source/contract review found no
blocking issue. Hosted evidence for that revision is recorded below; production
recovery is not inferred from local checks.

**Implementation examined:**
`f989da729267c8791683c95e0bdb8fa41c6e0d37`, tree
`af3deb814d401f5644df373ab7096e36d3be62d3`, tested at merge
`94486466565e290638ead6a875c5ba7b042f7a94` with identical tree and verified
main+implementation parents. The following logs/archives were actually inspected
on 19 October 2026. They remain tied to that implementation; later documentation
or code commits need their own applicable checks.

| Area | Examined run | Result and scope |
| --- | --- | --- |
| Frontend | [39284722377](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39284722377) | Both TypeScript configurations, five proxy, two access and five PWA cases, Vite6.4.4 production/image build |
| Backend | [39284722378](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39284722378) | Ruff/MyPy on 118 files, 1133 passed/12 skipped, image build |
| SSH | [39284722480](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39284722480) | Five native fixture cases |
| Indexes | [39284722855](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39284722855) | Seven real disposable provider cases with synthetic vectors |
| Stack | [39284722384](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39284722384) | 78 gate entries/76 unique, six built-browser gates, synthetic HTTPS/auth and independent 14-page restore |
| Browser | [39284722598](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/39284722598) | Six Passed/Cleanup records, nine successful phases, 496 successful phase executions/14 explicit skips; new search suite absent |

Both image builds used `push:false/load:false`; no image publication or deployment
is inferred. Browser profiles contain Chromium 298, first-start 2, Git-import 3,
scale320 2, WebKit reading 183 and workers 8. All six records identify the exact
merge, report no model calls/failure and confirm service cleanup. The opt-in
installation diagnosis was skipped.

Browser artifact 12202984092 is 186,001,632 bytes, SHA256
`1148bcb716f60f9a56e8b1076f15945ab1a35130d096273f6631fbce357fb246`.
API/upload digest, 744 safe unique regular paths and ZIP CRCs were checked; no
error-context was present. Narrow WebKit and desktop Chromium galaxy diagnostic
images were personally inspected. Stack artifact 12203650521 is
707,207 bytes, SHA256
`fca8b5ddc712b6bbd9aace5c081f78893dfd3b96f5e10c75e87c074775041948`;
its records/log, six safe paths/CRCs and narrow Home image were inspected,
including cleanup of both isolated projects and volumes.
Artifact retention ends on 26 October; the links and hashes do not guarantee
download availability afterward.

The first-start change had eight reproducible failing boundary cases before
correction and 101 related passing cases afterward; real filesystem/Git/seed
operations are distinguished from substituted service commands. Earlier UI and
transport reproductions remain in the pinned handoff and source history. Do not
replace a failed run with a later green result or compare phase execution totals
as though they were unique product requirements.

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

