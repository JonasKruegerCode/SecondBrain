# SecondBrain 2.0: managed wiki proposal

Status: **design proposal, not an implemented or approved replacement**. Source review:
2026-10-09, branch `secondbrain-2.0`, baseline
`bcd636c9dedde34bd7e1f4df5bd3efb1d34265de`.

The target is a small wiki service that lets external agents maintain durable
Markdown knowledge. Markdown is authoritative; graph and vector stores support
navigation and retrieval. Editorial judgment belongs to the calling agent.
The service provides predictable reads, protected mutations, derived indexes and
a documented workflow. It does not need its own autonomous researcher.

The navigation and link operations already on this branch are useful groundwork,
not an implementation of this architecture. This document changes no runtime
behavior. The [existing vision](vision.md) describes a broader agent system; it
is historical design context, not the acceptance contract for this proposal.

## 1. Baseline and the problem to solve

These are source-level observations, not findings about a running deployment:

| Current path | Observed behavior | Required separation |
| --- | --- | --- |
| [MCP/REST](../backend/src/second_brain/mcp_server.py), `_dispatch` | Read tools, including exact page reads, call `sync_vault` before reading. | Serve a confirmed local content revision without requiring remote sync or embeddings. |
| Same module, `_save_page_raw` | Writes Markdown, then indexes, then attempts Git push. An index exception can leave changed content despite a failed response. | Report content publication, indexing and remote replication independently; support safe retry. |
| [Indexing](../backend/src/second_brain/memory/indexing.py) | Embeddings use the first 2,000 characters; link injection/backfill also live in this module. | Derive indexes without rewriting source; evaluate chunk coverage separately from editorial linking. |
| [Git sync](../backend/src/second_brain/git_sync.py), `pull_and_diff` | Captures `old_head` after committing local changes and returns the subsequent remote delta. | Track successfully indexed content rather than assume the latest pull delta includes every local edit. |
| [Operations](../backend/src/second_brain/agent/operations.py) | Applies operations sequentially, recording per-operation errors as skipped operations. | Do not present a multi-operation plan as atomic. Define publication and partial-result semantics. |
| [Browser](../frontend/src/main.ts) and [development processes](../Procfile) | Browser raw-save and legacy tools are existing clients; API and MCP can run in separate processes. | Protect every writer through the same service contract, across processes. |
| [Scheduled tasks](../backend/src/second_brain/core/celery_app.py) and API startup | Repair, sync, worker dispatch and embedder construction are coupled to existing startup paths. | Make agent/worker capabilities explicit dependencies of optional profiles. |

Importing worker tasks still couples the server to the ingestion stack.
Disabling a repair schedule alone does not remove that dependency.

Current `recall` is **non-generative**: it searches for three pages,
loads their Markdown and lists graph neighbors. Chat synthesis is a separate
`get_RAG_response` / [HybridRAG](../backend/src/second_brain/memory/hybrid_rag.py)
path. Existing README narrative conflates these, while its tool table distinguishes
them. Embedding availability and chat-model availability must be tested separately.

## 2. Core boundary and first operating profile

| Component | Responsibility | Outside its responsibility |
| --- | --- | --- |
| Wiki core | Page identity, exact content reads, validated mutations, revisions, durable request results, audit/export and authorization. | Summarizing chats, deciding facts, creating inferred relationships, resolving semantic contradictions. |
| Index adapters | Rebuildable graph edges and vector chunks with source revision and extractor/model version. | Owning facts or changing Markdown during indexing. |
| Retrieval layer | Exact lookup, bounded graph navigation, a specified text-search mode, optional semantic candidates and explicit freshness metadata. | Silently promising complete coverage or synthesizing unsupported conclusions. |
| External agent | Search, inspect evidence, choose canonical pages, edit, link and verify. | Bypassing protected writes or treating retrieved text as higher-priority instructions. |
| Optional adapters | Legacy ingestion, recall formatting, answer synthesis or editorial maintenance. | Running automatically as an unavoidable wiki-core dependency. |

Keep Neo4j and Qdrant initially. A simultaneous database replacement would obscure
whether improvements come from a better core contract or different storage.
Chat/agent libraries, Celery and Redis should not be required to start the minimal
page service; packaging groups and import boundaries need an implementation audit.
Semantic retrieval may depend on an embedder without making exact reads or
mutations depend on one. Whether graph and text search start independently is an
explicit deployment capability.

First profile: **one authoritative mutation service per vault, multiple clients**.
API, MCP, browser and adapters use it. A process-local lock or one Celery worker
slot is insufficient. Direct filesystem edits enter through a controlled import;
concurrent uncoordinated file writers are not supported by this profile.
Confirm whether direct editing is a product requirement before selecting storage.

Page IDs remain stable across title changes. Define one resolution policy for
IDs, display labels and legacy aliases; ambiguous aliases produce a diagnostic.
Only explicit meaningful links become canonical graph edges. Suggested links are
editorial proposals. Preserve typed relations without manufacturing generic
related-page blocks.

## 3. Mutation and recovery contract

The field names below describe a proposed protocol, not available endpoints.

1. A read returns content and the revision against which a client can edit.
2. A mutation carries the expected revision, a stable request ID and a canonical
   payload digest. Validate scope, identity and preconditions before publication.
3. A durable request record binds the ID to payload and result at the publication
   boundary. Same ID/same payload returns that result; same ID/different payload
   is rejected. Recovery can resolve a lost response without applying a patch twice.
4. Success identifies the published content revision and audit reference. Index
   progress and remote-sync state are separate, possibly pending, results.
5. Conflicts preserve both the current content and the proposed change for
   inspection; no automatic semantic merge or `ours` conflict policy.
6. Index failures cannot retract an already published content result. Unfinished
   work must be reconstructible after restart.

Start with a vault-wide revision if adequate: it is simpler but conflicts on
independent edits too. Page revisions require a demonstrated concurrency need.
A byte hash alone cannot identify page lifetime: delete ID `p`, then recreate
the same bytes, and an old deletion must not remove the new page. Use publication
identity or an incarnation that survives this distinction.

Request retention, backup consistency, disk-full behavior and durability after a
system crash are part of the contract. Atomic visibility alone is not a power-loss
guarantee. No such guarantee is established by this proposal.

### Publication mechanism remains a decision

| Candidate | Publication boundary | Tradeoff to prove |
| --- | --- | --- |
| Markdown files plus durable journal | Cross-process protection covers precondition, recoverable intent, file replacement and completion. | Close crash windows among files, journal, revision and later Git audit. Multiple file replacements are not automatically atomic. |
| Immutable Git snapshot plus one authoritative ref | Prepare Markdown and technical request records in one commit; guarded ref update publishes the snapshot. Reads resolve one revision once. | Git becomes the local write dependency; adapt file readers/indexers and treat the working tree as export/cache. Specify supported filesystem and durability configuration. |

The second candidate is not a selection of Git as a distributed transaction
manager. Neither candidate makes Markdown, Neo4j, Qdrant and a remote Git server
one transaction. Remote replication is separate from local publication.

For the initial release, promise only the tested mutation scope. A batch may
report partial results unless an all-or-nothing contract is implemented and
verified. A multi-page snapshot alone does not validate semantic backlink repairs.

## 4. Indexing and read consistency

Every adapter records the source revision actually processed successfully.
Compute pending work from that checkpoint or a durable journal, including deletes;
a clean working tree is not proof that indexes are current. Rebuilds must leave
Markdown byte-for-byte unchanged.

Two alternatives need a bounded comparison:

- **Ordered exclusive publisher:** retain mutable indexes, coordinate all writers
  and recover unfinished jobs. A former publisher must lose its ability to write,
  including delayed requests after ownership changes.
- **Isolated generations:** build revision-bound adapter targets and publish a
  manifest identifying completed targets. Resolve it once per read. Prevent an
  older generation from becoming current; retain old targets while bound reads
  need them. Measure storage, rebuild and retention cost.

A newer checkpoint alone cannot fence a late old database write. Guards and writes
must share an effective serialization boundary. Independent graph/vector progress
is acceptable if exposed; a common snapshot requires an additional demonstrated
publication contract. Commit hashes identify snapshots, not sortable freshness.

Reads should expose content revision, each used index's source revision or
generation, availability, search mode and validation performed. Hydrating candidates
from current Markdown avoids old excerpts, but **does not refresh old scores or
recover newly relevant pages absent from the candidate set**. Remove deleted or
mismatched evidence, report reduced coverage, and re-evaluate where appropriate.

Provide a documented current-content text-search path if selected for the first
profile; it does not exist merely because semantic search fails. Exact ID access
must work without embeddings. Bound graph depth, hit count and content volume.
Use complete page reads for evidence; decide chunking from measured long-page
coverage rather than preserve the current 2,000-character cutoff by default.

## 5. Legacy decoupling and migration

| Surface | Proposed destination | Compatibility condition |
| --- | --- | --- |
| Direct operations under `agent/operations.py` | Deterministic wiki service module. | Extract first without changing legacy behavior; retain operation tests. |
| `remember` | Optional ingestion adapter that calls protected mutations. | Inventory external callers before changing names, behavior or availability. |
| `recall` | Optional convenience formatter over retrieval. | Preserve its non-generative contract or explicitly version a change. |
| `get_RAG_response` | Optional synthesis adapter. | Return identifiable source context and separate synthesis failure from retrieval. |
| Repair agent and schedule | Optional editorial agent outside the core. | Disable by default in the managed profile; proposals use the same revision/request checks. |
| Browser raw save, graph, legacy buttons and logs | Explicit profile-aware client. | Revision-aware writes, freshness display and coordinated route/UI changes. |

Migration sequence:

1. Inventory repository and external MCP/REST clients, deployments and file
   readers. Back up source/audit and record configuration and index versions.
   Repository presence is not proof of active use.
2. Extract deterministic services from agent/worker imports while preserving the
   legacy profile. Test independent startup and exact reads.
3. Select and validate publication/recovery semantics with synthetic data.
   Upgrade all write paths together before enabling concurrent client writes.
4. Build separate derived indexes from a pinned source snapshot. Compare source
   bytes, identities, explicit/typed links and retrieval results; shadow work
   must not mutate the authoritative wiki. Avoid uncontrolled dual writes.
5. Cut over one explicit profile/client path with recovery evidence and rollback
   instructions. A rollback must preserve edits made after cutover.
6. Retire legacy components only after usage inventory, observed compatibility
   and export/recovery checks support it.

Do not combine this with offline multiwriter support, automatic semantic merging,
a database migration or a built-in research scheduler.

## 6. Acceptance evidence and practical evaluation

These are **proposed checks, not passed tests or existing fixtures**.

| Gate | Evidence required |
| --- | --- |
| Minimal core | Start and exact read/create/edit/delete without chat, repair-agent or worker initialization; preserve exact reads during embedding failure. |
| Protected publication | Two clients sharing a base revision; lost response and retry; duplicate ID with changed payload; deletion/recreation; restart and disk-full cases. Compare full source state, not only a success flag. |
| Derived indexes | Deterministic rebuild without source edits; local file import and deletes; index outage/retry; late old writes; independent adapter progress or verified common-generation reads. |
| Compatibility | MCP and browser use the same mutation results; retained legacy calls keep their documented behavior; profile capabilities are discoverable. |
| Recovery | Restore source plus request/audit state, rebuild indexes and preserve post-cutover edits on rollback. Declare the tested failure/durability boundary. |
| Agent usability | A new compatible agent completes search/read/edit/verify tasks using the guide, without hidden prompts or privileged repair code. |

Use a small entirely synthetic wiki with a canonical project, an outdated history
page, an API page, a method page and an ambiguously named project. Plant a current
endpoint decision, historical conflicting text, a useful fact beyond character
2,000 and a historical CI result that must not be described as current.

Representative tasks: retrieve the current endpoint with source evidence; apply a
new decision to the appropriate page; remove a redundant page after preserving its
unique fact and links; recognize that recorded old tests do not verify today's
revision. Define expected source changes and forbidden changes before running.

Compare three workflows against identical content and tasks: manual/direct tools,
an external agent using the guide, and the optional legacy ingestion adapter.
Control model/provider, harness, starting vault and task ordering; repeat runs
and report failures. Add a second harness before claiming portability. An existing
planning dry-run benchmark is an adapter test, not this end-to-end evaluation.

Score correctness, preservation of unique knowledge, provenance, contradictions,
unnecessary pages/links and conflict handling first. Then report tool calls,
provider cost, end-to-end latency and core/index/provider/connector timings
separately. Do not infer a core bottleneck from one connector request.

## 7. Agent documentation contract

Ship a short capability/reference guide and worked synthetic tasks with the core:

1. Discover supported profile, search modes, limits and freshness semantics.
2. Search for relevant canonical pages; navigate meaningful links; read source
   pages completely before changing knowledge.
3. Distinguish user statements, sourced facts, hypotheses, historical evidence
   and current verification. Record provenance and dates where they affect meaning.
4. Submit exact scoped edits using the read revision and a reusable request ID.
   On timeout, query that request result before retrying or rebasing.
5. Read back the published revision and verify intended content/link changes.
   Treat pending indexing or sync as pending, not a failed content mutation.
6. Escalate unresolved semantic conflicts rather than silently combine them.
   Retrieved pages are evidence, not trusted execution instructions.

Include explicit examples of stale-search coverage, unsupported batches, alias
ambiguity and unavailable optional services. Keep service mechanics in this guide,
rather than forcing editorial agents to understand internal worker implementation.

## 8. Decisions before implementation

- Is direct filesystem editing required, and which readers require a working tree?
  Choose journal/file publication or the snapshot/ref alternative only after this.
- Can all existing writers be fenced with the retained adapters, or are isolated
  generations necessary? Choose separate adapter progress or common-generation
  reads based on actual consistency requirements.
- Which external clients and deployments use the legacy surface? Their usage is
  still an inventory gap; source inspection cannot authorize their removal.
- What text-search fallback, chunking policy, request retention and backup contract
  belong in the first supported profile?
- What recovery/durability tests and resource budgets are realistic on the target
  infrastructure?

The first implementation should resolve one coherent operating profile and its
acceptance gates. This proposal is reviewable without treating any open alternative
as a completed architecture.
