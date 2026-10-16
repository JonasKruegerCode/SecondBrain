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

Legacy page IDs beginning with ASCII hyphens are retained without renaming.
The same bounded ID contract applies to import, reads, edits, export and saved
chat sources. Synthetic option-shaped IDs exercise literal Git/file handling;
leading dots, traversal, separators, whitespace and oversized IDs stay invalid.
This compatibility fix does not establish a complete private-vault migration.

The store regression also terminates an owned child process at controlled
boundaries immediately before and after the real Git ref update. Reopening the
store and retrying the exact request must recover one publication and its
receipt, without an extra history entry. This covers process loss at those
boundaries; it does not emulate power loss or interrupt Git's ref transaction.

The demo launcher defers SIGINT/SIGTERM during child creation, registration and
process-receipt publication, then stops before launching another child. Twelve
native supervision cases run its actual main with real ephemeral socket
children: both signals at either child/receipt boundary, repeated stop signals
during cleanup and controlled receipt-write errors. They check closed sockets,
reaped direct children and accurate receipts. Only the service commands are
substituted; this is a process-boundary fixture, not another API/browser pass.
SIGKILL in the creation/receipt gap remains outside this guarantee.

Four separate native hard-loss cases kill the real supervisor after its complete
receipt or before either Popen returns, then call the actual acceptance cleanup.
Recorded sockets close; the unrecorded child stays live until independent
test-owner cleanup. The actual acceptance failure path writes failed evidence
and retains the vault, controlled phase inputs and process records. No browser
is launched in that fixture. Linux adopts and reaps only ledger-owned orphans
inside a restored process-local subreaper scope; other POSIX systems check
socket closure. These cases validate the explicit failure contract and do not
extend the launcher's SIGKILL recovery guarantee.

Neo4j, Qdrant/embeddings and remote Git are recoverable derived services. Their
generation or delivery receipts remain separate from the Markdown publication
receipt, so a pending or failed provider cannot be reported as current. The wiki
continues to provide exact reads, lexical search, local history and explicit
Markdown graph navigation without those providers.

Long chat page reads now expose bounded character chunks with `offset`,
`total_chars`, `next_offset` and the page revision. A continuation must provide
`expected_revision`; a changed snapshot returns an explicit conflict instead of
silently combining different revisions. The next cursor is calculated from the
actual Markdown delivered after JSON escaping and envelope budgeting, so no
characters are skipped. Oversized metadata returns a bounded error rather than
an empty, non-advancing continuation. Tool results stay within 8,000 characters;
the existing eight-call/five-round limits are unchanged. Synthetic service/API
regressions cover exact reconstruction, late evidence, malformed cursors,
revision changes and metadata-budget boundaries. Scripted providers establish
this protocol contract, not real-model answer quality.

The non-streaming OpenRouter tool-chat boundary requires an explicit completed
`stop` or `tool_calls` finish reason. Token-limit, filtered, failed, missing or
unknown completion states return the existing sanitized unavailable error;
partial text is not saved as a successful reply and unfinished tool batches do
not execute. There is no automatic new generation for this condition. The
question remains available for a deliberate Retry. Normal completed messages,
the 1,200-token limit and transport retries remain unchanged. Synthetic HTTP
transport/API cases verify this boundary and retry recovery, not live model
quality. The normalized finish reasons are documented in the
[OpenRouter API reference](https://openrouter.ai/docs/api_reference/overview#finish-reason).

The local Vite proxy now closes the outgoing chat request when its browser
disconnects before the API has sent response headers. A fully uploaded POST
does not emit the incoming-request abort event, so the previous development
proxy could leave the provider running after Stop reply. The hook is scoped to
chat POSTs, preserves completed responses and removes its close listener after
upstream completion; it also handles an already disconnected request waiting
for an upstream socket. Native HTTP/Vite regressions check cancellation,
concurrent isolation, the queued-socket race, normal/error completion and the
unchanged page-write boundary. A held synthetic provider through the real
ASGI app and browser establishes development-path cancellation, not live model
billing or production reverse-proxy behavior.

The optional chat is a bounded OpenRouter function-calling loop over search,
exact page reads and graph neighbors. It has no write tool and no backend
conversation archive. Visible sources contain only pages the model actually
read. Browser-local conversations are bounded and deletable; each write merges
the current store, and bounded deletion tombstones prevent a stale tab from
losing or resurrecting independent conversations. Before submitting from a stale
view, the composer adopts the latest saved transcript without discarding unsaved
storage-fallback messages. Retry first displays a newer saved transcript instead
of resending an already answered question. If another tab changes the transcript
while an answer is pending, the answer is retained in a separate conversation
with its original request context; the newer stored conversation is preserved.
Recovery from failed browser writes also keeps a divergent unsaved branch in a
separate conversation before any persistence action, including Send, Retry, New
and history selection. An unchanged saved prefix still
recovers normally. Deletion still wins over an in-flight reply. These guards compare transcript
content rather than timestamps. Browser storage is not a transactional multiwriter
database: simultaneous cross-document writes and eviction beyond the bounded
history remain outside this guarantee.

The concurrency regression uses a real unconfigured chat error for stale
submission/retry and a held synthetic answer adapter for the late-reply race;
it does not establish real model quality. Both browser reading profiles run
these cases, including 390px and 1440px stale-view notices and reload persistence.

A full browser-local history scrolls within the desktop conversation list instead
of stretching the whole workspace and pushing the composer below the viewport.
All twenty entries remain reachable by native keyboard focus, selection and
reload; narrow screens retain their horizontal conversation strip. Rendering
regressions use only synthetic saved transcripts, not generated model answers.
The update backup command resolves the active vault inside the container,
including an explicitly retained restored-vault override; it must not assume
the volume root remains the active vault after recovery.

OpenRouter failure diagnostics retain attempt number, exception class and HTTP
status, without raw exception messages, response excerpts or chained provider
tracebacks. Automatic HTTPX tracing is suppressed around these requests; bounded
client spans still expose timing and status. Synthetic transport regressions
exercise HTTP/transport/JSON failures, successful retry and cancellation during
request/backoff. They do not establish real-provider delivery or billing behavior.
HTTPX INFO and HTTPcore DEBUG transport logs are suppressed only in the provider
task's context because they can include peer-controlled reason phrases, response
headers and exception text. Filters attach to HTTPcore's actual emitting loggers;
a parent-logger filter would not intercept child records. Real loopback HTTP/1.1
tests with the default HTTPX transport verify success, HTTP/JSON failure and
cancellation, positive-control DEBUG output, concurrent ordinary logging, same-task
restoration and client closure. Ordinary requests retain their logs; levels are
unchanged. These checks do not establish live-provider, HTTP/2, TLS or proxy behavior.

## User and operator paths

- First start explicitly chooses an empty wiki, the fictional template or a
  reviewed local Git import. A nonempty destination is never seeded implicitly.
- The main user flow is Home -> article and wikilinks -> search/history/editor ->
  galaxy -> optional chat.
- Article lists retain Markdown meaning: continued numbered lists keep their
  starting number (including zero), and task markers keep checked/unchecked
  state as disabled native checkboxes. Other form inputs remain stripped;
  no task toggle writes to the wiki. Raw editor Markdown remains authoritative.
  Long unbroken article titles wrap inside the reading surface instead of
  widening the document; the same narrow/desktop regression checks this.
- Preformatted code has an explicit Tab stop and visible focus, so keyboard
  readers can scroll long lines horizontally and continue to the next link.
  The native regression also preserves literal script/wikilink syntax and
  whitespace through reload/editor reads; it performs no wiki write.
- Article image acceptance loads a synthetic 2400-by-600 SVG through the real
  server at narrow and wide viewports. It checks proportional containment,
  lazy loading, alternative text, real missing-resource failure and unchanged
  editor/reload Markdown. Rejected sources and source event/style/size
  attributes stay inert. This is same-origin browser evidence, not an external
  image-host, production proxy or screen-reader acceptance.
- With forced contrast colors, the galaxy SVG uses the active system palette
  for labels, stars and links; current navigation and selected controls retain
  visible outlines. The normal wiki/space palettes remain unchanged. The real
  Chromium regression checks light/dark contrast media at 390/1440px, keyboard
  selection/article entry, no overflow and an unchanged graph snapshot. This is
  browser media emulation, not a physical Windows contrast-theme or screen-reader
  acceptance; WebKit is not claimed to support this emulation profile.
- Browser Back/Forward returns to the preceding Galaxy visit's selected page,
  constellation, query, map/list choice, zoom, pan and sidebar offset. These
  bounded visit states stay only in tab memory; the graph is fetched again and
  deleted page IDs cannot restore a stale selection. Explicit new visits and
  refresh open the overview unless the URL requests a specific page; contextual
  URLs reselect that page from the fresh snapshot. Reload does not persist
  Galaxy exploration state.
- A continuous fictional-atlas browser rehearsal follows Home -> article ->
  wikilink -> real search -> constellation/star/link evidence -> article ->
  Chat. With the demo's unconfigured provider it verifies the actual unavailable
  response, retry, local question reload/deletion and conversation-specific unsent
  drafts at narrow and wide viewports, never a fabricated answer. Drafts stay only
  in the open Chat view; Retry sends submitted messages and preserves composer
  text. Switching conversations restores their separate drafts, deletion removes
  them, and Send clears only the submitted draft. This
  automated path is not the final real-model demo rehearsal.
- Explicit navigation focuses the destination title for articles, Home, Search,
  Galaxy, Chat, link choices and route errors, so the next Tab continues within
  the view. Chat arrival leaves the composer unfocused. Fresh document loads retain the skip-link path;
  fragments take precedence. A header/main focus deliberately chosen while a
  read is pending is preserved, including internal saved-start/link redirects.
- An article reload from incoming-link revision mismatch retains the history
  panel's latest open state and a deliberately chosen history summary focus.
  The panel is recreated and fetches current history through its normal listener;
  detached old replies remain ignored. This does not promise focus preservation
  for every possible node inside replaced article content.
- Article contents links retain the browser's modified-click behavior. Ctrl/Cmd
  opens the section URL in another tab; the original article stays in place.
  Ordinary click/Enter focuses and scrolls its section within the current visit.
- Search normalizes submitted queries while retaining the current URL fragment;
  direct fragment destinations, reload and history remain usable. Later form
  submissions keep their input focus, including a new or empty query.
  A stable polite status region reports loading, result count, no matches and
  retryable errors for the submitted query, independently of the next input
  draft. Older replies cannot replace that status. Result cards stay outside
  the live region; focus is not moved to announce a response. Browser DOM/ARIA
  checks do not substitute for a physical screen-reader session.
- Reopening local Git history reads current commits, including newer agent saves.
  Reopening during a pending read shares that request; late history replies after
  leaving the article cannot replace the next article's history.
- Incoming-link refresh/retry and revision-mismatch replies restore their lost
  button focus only while it remains unclaimed. Reloading a changed article
  also respects a header control deliberately focused during its pending read,
  on success or failure. Uninterrupted keyboard reload still arrives at the
  article heading. Reload replaces main content, so this does not promise to
  preserve a focused node inside that replaced subtree.
- Save conflicts preserve the local draft and require a fresh read plus deliberate
  reconciliation. Lost acknowledgements are retried with the same request ID and
  payload, including an edit followed by restoring the exact submitted draft,
  or a newer edit rejected with a conflict before that restoration.
  Retry identity belongs to the submitted page/revision/content, so a
  different payload remains a distinct attempt and cannot silently overwrite
  a concurrent revision. One unresolved attempt is retained in this view's memory;
  a definitive conflict does not replace an earlier lost-ack receipt.
- Backup/restore includes Git history, durable local ledgers and demo metadata.
  Content-only export is separate and is not a full operational backup.
- Remote Git delivery requires reviewed local and remote heads. It never performs
  an automatic pull, merge, force-push or conflict adoption.

Background PWA update checks keep the active worker when the native update
operation rejects after an unavailable worker-script fetch. A later visibility check can retry;
this does not change worker activation, draft protection or private-cache policy.
The regression uses real workers and a forwarding observer of native outcomes;
the server's one-shot HTTP 503 and visibility event are synthetic. Offline UI
and successful reconnection are checked separately; offline emulation alone did
not establish a native update rejection. It does not explain the separate intermittent
first-install update notice or establish physical-device behavior.

## Public interfaces

The managed REST surface under `/api/wiki` covers health, page
list/read/save/delete, link resolution and explicit incoming links,
lexical/semantic/GraphRAG search, graph,
history, index/delivery status and bounded chat. Mutation requests carry
`base_revision` and `request_id`.

REST rejects invalid authentication with a sanitized 401 response and `no-store`,
including non-ASCII header bytes. Browser writes and chat reject malformed
Origins with sanitized 403 responses before content or model dispatch. Origin
validation rejects invalid authorities, user information, paths, queries,
fragments, whitespace and control bytes; it compares the proxy-visible Host
authority so HTTPS reverse proxies keep working. Authenticated nonbrowser
requests without Origin remain supported. These are application boundary
regressions, not production reverse-proxy or physical-browser acceptance.

Managed MCP exposes ten deterministic tools: page read/list/search/save/delete,
graph/neighbors, history, index status and delivery status. The
`wiki://guidance` resource documents the editorial and retry contract.
`remember` and `recall` remain only in the separately configured legacy
profile.

## Reproduce the demo and checks

Use Linux or WSL with Python 3.12, Poetry 2.1.3, Git, Make and Node 20+. From the
repository root (the subshells keep the terminal there):

```sh
(cd backend && poetry sync --no-interaction)
(cd frontend && npm ci && npx playwright install --with-deps chromium)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
SECOND_BRAIN_WIKI_API_KEY= make demo PYTHON="$WIKI_PYTHON"
SECOND_BRAIN_WIKI_API_KEY= make acceptance PYTHON="$WIKI_PYTHON"
SECOND_BRAIN_WIKI_API_KEY= make acceptance-first-start PYTHON="$WIKI_PYTHON"
SECOND_BRAIN_WIKI_API_KEY= make acceptance-import PYTHON="$WIKI_PYTHON"
make check
```

The backend suite also includes a native mixed-transport regression. To run just
that boundary from the repository root:

```sh
"$WIKI_PYTHON" -m pytest backend/tests/test_wiki_transport_processes.py
```

It starts separate authenticated REST and Streamable HTTP MCP Uvicorn processes
on owned dynamic loopback sockets with one synthetic Git authority. Synchronized
client submissions check competing same-base writes, identical request receipts
and refusal of a reused ID with changed content. After a later edit and restart
of both services, replay through each transport returns the original receipt
without adding a commit or reverting current content; reads/history agree. The
fixture disables delivery/index/model providers, stops and reaps its owned
processes, and never uses a personal vault. Client synchronization does not force
a particular server-side CAS interleaving; this complements the lower-level
publication-race tests. It is not browser, proxy, provider or crash-durability
acceptance.

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
`make acceptance-scale PYTHON="$WIKI_PYTHON"` runs the existing scale suite
against a fresh owned 320-page synthetic Git vault. The fixed `--scale` profile
rejects other profiles, filters and repeats; its structural record identifies
the scale fixture and cleanup, and screenshots stay under that run's
`browser-scale` output. Browser CI runs this bounded graph/mutation/history gate
separately from the fictional-atlas suite. It is a local-browser fixture check,
not a production load or physical-device guarantee.
For a concrete intermittent failure, `--browser-grep PATTERN --repeat-each N`
selects a bounded diagnostic run against the same real services. Its structural
record includes the filter and repetition count; a filtered pass is not full
acceptance. First-start phases reject these options. The save-body test records
monotonic phase timings and runner fixture/hook timings, including final status.
The 30-second timeout reproduced with timing on `8f3b0d3`: assertions completed
in under a second, but closing the owned proxy waited about 29.4 seconds after
page closure. It completed only as the runner closed the context after timeout.
The test now closes its whole owned browser context before the proxy, preserving
the real held-body/save/receipt checks and the existing deadlines. A provisional
`passed` inside cleanup does not prove runner completion. Five earlier isolated
passes on `6394004` did not establish a fix; use the current revision's actual
normal and bounded-diagnostic results to assess the corrected cleanup order.
The normal suite includes focused history checks against actual Git-backed REST
responses: keyboard loading, pending-read deduplication, refreshed agent edits,
transport failure/retry and late success/failure after article navigation.
The history module is selected once in both Chromium and WebKit reading profiles.
Four same-article cases also hold an actual Git history reply through editor
entry, then release success or a scripted transport failure during editing or
after a real UI save. They compare the current commit list with REST history,
check editor identity/selection or saved-article focus, and retain the same visit
at desktop and narrow widths. Successful history payloads are never fabricated.
Four Cancel cases perform the whole interaction at 390px or 1440px: an independent
REST writer commits while a draft and old history reply are held. Cancel must
reread the current article without a browser write; late history success/failure
must leave its revision, commit list, focus and visit intact. Paired viewport and
full-page images distinguish offscreen skip-link geometry from capture effects.
Transport delays/aborts are explicitly scripted, not claims of real API outages.

The delivery recovery suite owns a separate loopback API, forwarding proxy,
temporary vault and local bare Git target. It saves real Markdown while its Git
target is renamed out of reach, runs actual delivery to observe an error, then
restores the target and runs delivery again without another content commit.
The article's read-only **Check sync status** action exposes the recovered cached
acknowledgement. Both browser profiles exercise desktop and narrow paths; local
reads, history, lexical search and explicit links remain available throughout.
The fixture disables inherited hosted providers and uses no fabricated status
responses. It is not a hosted Git, SSH, index-provider or production acceptance.
The same owned fixture also advances its bare target with an independent normal
Git commit/push. Two subsequent local browser saves remain available while
delivery and the read-only status action keep reporting conflict. Actual remote
Markdown/head, local revisions/history/search/links and exactly two browser
writes before operator review are checked; a repeated delivery attempt cannot
adopt or overwrite the independent revision. No automatic reconciliation is
exercised or authorized.
An explicit scripted operator review then reads both actual Markdown snapshots
and retains the independent paragraph through a third browser save. Actual CLI
calls reject stale local and remote guards separately. Reviewed reconciliation
only prepares pending delivery without changing either content/head/history;
the next ordinary delivery publishes the merged text on top of the independent
remote commit. The read-only UI refresh shows the recovered acknowledgement,
with exactly three browser writes and no extra local content commit. This is a
synthetic operator rehearsal, not automated conflict resolution or private migration.

The shared `editor-retry.spec.ts` suite is selected once by both the full Chromium
profile and the WebKit reading/navigation profile. Its six timeout cases withhold an
actual successful save response and advance the client clock: unchanged retry,
a different draft's real conflict, restored content, and restoration after a
rejected intermediate edit, plus keyboard input → undo → redo → undo before
receipt replay, plus preservation of pre-save keyboard history and selection.
A seventh case checks pre-save undo/redo and selection after a real conflict
with an intervening agent write. The editor remains the same textarea during
saving and failure, read-only while saving; status and preferences update in
place. A failure returns focus from Save to the draft without overriding another
control chosen meanwhile. Success closes the editor. These browser editing
commands do not establish physical keyboard input or mobile virtual keyboards.
Two longer synthetic drafts additionally check internal textarea scroll,
backward selection and deliberately chosen History/toolbar focus across timeout,
then native undo/redo and either receipt replay or dismissed/accepted Cancel.
Cancel closes the local editing view; it cannot roll back a save already
committed despite a lost acknowledgement. Accepted Cancel reads the current
article on the same visit before offering Edit again; unavailable reads use
the existing error/retry view instead of presenting the older snapshot.
API/history readback verifies that distinction before and after reload.
Three real-conflict cases also check current content before re-editing, an
unavailable refresh with same-visit retry, and a late read after navigation.
They preserve deliberately chosen header focus and verify no additional write.
Cancel after a real deletion shows the missing-page view without recreating the
article. Section URLs retain their fragment and visit; delayed reads preserve
chosen header focus. A newer native fragment starts a newer read, and a header
choice during that read still takes precedence over automatic section focus.
Those section cases pair actual viewport captures with full-page images and
record the unfocused Skip link's viewport geometry before and after capture.
An offscreen fixed element can appear in a full-page image; that image alone
does not establish visibility over the article in the current viewport.
Paired real graph reads at 390/1440 pixels also check a text-only edit with
unchanged title/topology: curated core/world positions and directed bridge
evidence remain equal while the actual snapshot revision advances. SVG world
coordinates and viewport fitting are recorded separately; this bounded check
does not establish stability after arbitrary added/deleted links, groups or pages.
A separate directed-link mutation checks two existing fixture groups with retained
anchors at 390/1440 pixels: a real save adds exactly one leaf-to-leaf link to an existing bridge,
the UI refresh reads the current graph, core world positions and unrelated bridges
stay unchanged, and the evidence panel retains the actual source/target direction.
World positions and viewport fitting are recorded separately. Ordinary stars may
reorder with their degree rank; this bounded check does not promise fixed positions
for every star or topology-derived group. File attachments preserve both snapshots.
The source fixture has three initially tied ordinary stars. Promoting the last
one with the new link exercises their degree-ranked slot rotation while every
other star, including the retained unique anchors, stays in place. This expected
local reorder is distinguished from a global layout jump. Focused evidence views
also pair viewport/full-page images with before/after Skip-link geometry, page
scroll and actual article focus; captures must not change that state.
These desktop/narrow cases are not arbitrary-size performance benchmarks.
They inspect real request payloads, receipts and Git history, then remove only
their owned UUID page using its current revision; no save response is fabricated.
WebKit keeps service workers blocked
for observable held routes, while the separate worker gate keeps them enabled.
For a focused check, add
`--browser-engine webkit --browser-grep 'a timed-out save preserves'`
to the acceptance runner. A filtered pass is not the entire WebKit
profile and Linux WebKit does not establish physical Safari/iOS acceptance.

Two skip-link cases compare actual viewport geometry and keyboard behavior at
390 and 1440 pixels. First Tab reveals the navigation bypass; Enter focuses the
main content, and the next Tab enters its first control. The same-fragment path
is checked too. A scrolled full-page Chromium capture can include the unfocused
fixed link even though its rectangle remains entirely above the real viewport.
The paired viewport images and before/after geometry distinguish that capture
artifact from the interface. Do not infer a visible overlay from full-page
pixels alone or from Playwright's offscreen `toBeVisible()` result.

The local Git-import runner uses the actual setup CLI and three browser phases:
empty Git without seeding, the public atlas with two original source commits,
and restart after a browser edit and saved start page. It compares every page's
exact content/revision, real source history and the full graph; checks links,
search and galaxy at desktop and narrow widths; and refuses new first-start or
template requests over the edited wiki. An identical import retry retains its
original receipt while reporting the newer content revision. The source remains
unchanged. Owned source repositories, vaults, browser state and page receipts are
not uploaded. This gate does not establish a private or remote Git migration.

For the opt-in tall-map probe, create an isolated vault with
`"$WIKI_PYTHON" -m second_brain.wiki.scale_demo --vault .demo/tall-vault --pages 320 --groups 24`,
start `SECOND_BRAIN_WIKI_API_KEY= "$WIKI_PYTHON" scripts/run-wiki-demo.py --vault .demo/tall-vault`, then run
`PLAYWRIGHT_TALL=1 npm run test:browser -- e2e/tall.spec.ts` from `frontend`.
Use the selected Poetry Python from the setup above and export
`PYTHONPATH="$PWD/backend/src"` from the repository root before the Python
commands. This uses real Markdown/Git and graph services, with no model
calls; it is separate from the normal browser CI suite.

For the human presentation route and its evidence checklist, use the
[manual demo rehearsal](demo-start.md#manual-presentation-rehearsal). It includes
readability, actual saved content/history, galaxy link evidence, two related
questions with source inspection, local deletion and restart. It is a recipe,
not a claim that real-model or physical-device acceptance has passed.

With explicit approval for paid external calls and a real key:

```sh
OPENROUTER_API_KEY=... make acceptance-openrouter PYTHON="$WIKI_PYTHON"
```

With a real configured provider this is a structural OpenRouter check, not an
answer-quality review. Its schema-2 evidence distinguishes attempted/completed
client invocations and chat turns, and records vault integrity as unknown if
not checked. Reading the required pages does not prove correct interpretation;
the record explicitly keeps `answer_quality_reviewed=false`. Inspect the actual
answers and cited pages through the manual tour before closing that gate.
Client counts do not establish HTTP delivery, internal retry counts or billing.
Hosted index, deployment and device behavior remain separate.

For direct agent maintenance, use the separate nine-page
[editorial rehearsal](editorial-rehearsal.md). Its dated controlled result covers
source-based corrections, knowledge-preserving consolidation, meaningful links
and real MCP conflict/retry/restart behavior. It is author-aware and establishes
neither a comparative quality score nor real-provider answer quality.

## Evidence snapshot

Verified published implementation baseline `fc136028244134112d0dbb29acf6576bf9740b92`
(tree `585501d90a5ad32aeb35b69ea0fc3340c971c94d`, 2026-10-12).
These results identify that exact baseline; for later commits inspect the
current [draft PR #18](https://github.com/JonasKruegerCode/SecondBrain/pull/18)
and its matching CI runs rather than treating these counts as current.

- The real CI API/Vite/Chromium acceptance passed 75/75 in 63.505 seconds with
  services, including fresh history and both skip-link viewport/keyboard cases.
  Existing empty-first-start/restart phases passed in 7.787 seconds; the three
  local-Git import phases passed in 11.522 seconds. Their two/six phase skips are
  intentional. Native import/skip-link browser execution was unavailable because
  the temporary Chromium environment expired and its replacement download was
  blocked; do not describe the CI browser pass as a native local pass.
- All three structural records show `external_model_calls=false`,
  `vault_retained=false` and `phase_inputs_retained=false`; the import source is
  removed too. Artifact `11770743390`, ZIP SHA256
  `e3467f74f3fb5a16decd9981387478f85e7db58906fc11aeac915c7a80daaba3`,
  was downloaded and matched GitHub's digest. Paired viewport/full-page/focused
  images were opened and inspected. No source repositories, vaults, browser
  state or page receipts are archived. This is not a real-model/device check.
- All six workflows passed: [Backend #111](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38302838040),
  Frontend #90, [Managed stack #53](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38302837894),
  Managed index #51, Managed SSH #40 and
  [Managed browser #36](https://github.com/JonasKruegerCode/SecondBrain/actions/runs/38302837865).
  Backend Ruff and strict MyPy over 88 files passed with 328 tests and 12
  explicit opt-in skips (64.05 seconds); backend and frontend image builds pass.
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

## Article-to-galaxy entry

Read-mode articles provide an **Explore connections** link to
`/galaxy?page=<encoded-page-id>`. The fresh graph resolves the exact stable ID
and its existing constellation; no title inference or invented relation is
added. Large snapshots still open in list mode. The global Galaxy link remains
an overview. A missing/deleted target gets an explicit snapshot notice without
echoing untrusted URL input. An existing visit restores its exploration on
Back/Forward; a new snapshot refresh or full reload resolves the URL's page
again. This state is still bounded, in-memory and not a graph copy or persisted
exploration archive.

`article-galaxy.spec.ts` joins both real-service Chromium and WebKit reading
profiles; the existing synthetic320 suite covers contextual entry with list
mode. A separate 390/1440px case edits an owned synthetic page through the real
Markdown editor in another tab: title, curated group and explicit link change
while its ID stays stable. The existing map retains its shown snapshot until
navigation/refresh; history return reads the new graph and resolves the same ID
to its new title, real constellation and evidence. Cleanup checks restored graph
nodes/edges. These are automated browser checks, not physical-device or manual
demo acceptance.

The same profiles inject one contextual graph-read transport failure and then
retry against the actual service. An intervening owned-page mutation checks
that recovery retains the URL/history visit while resolving current content;
no successful response is fabricated.

A further 390/1440px regression holds an actual fetched graph response while
the user follows Search to another article and opens its connections. Releasing
the abandoned response must retain the current context, deliberate exploration,
history visit, focus and reading position. Search/Back then verifies that the
current visit still owns its exploration cleanup. The gate delays delivery only;
both graph payloads come from the content service.

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
