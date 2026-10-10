# Recoverable managed delivery

Local Markdown publication is the acknowledgement boundary. REST/MCP keep the
original immutable save/delete receipt: retry that exact request ID and payload
when a reply is lost. That receipt describes publication-time index/remote
state, not current progress. Read `GET /api/wiki/delivery-status` or MCP
`get_delivery_status` for current **workspace** progress. A workspace Git head
and a page's revision token are different identifiers.

## Runtime and restart

The managed REST, HTTP MCP and stdio factories now own a background delivery
worker by default. Low-level `create_app`/`create_http_app` remain manual unless
`automatic_delivery=True` is explicitly supplied. Set
`SECOND_BRAIN_WIKI_DELIVERY=0` to turn off background work. Optional index
providers use the existing [managed index settings](managed-indexes.md); default
startup needs no model or provider. Without optional providers, lexical search
and the immediate Markdown graph still work.

The worker wakes after a transport save/delete, on startup and every two
seconds. Signals are hints: it reconstructs pending work from content heads and
durable index/Git receipts, including writes made by the other process. A
nonblocking per-vault lock serializes REST/MCP delivery workers. Multiple
processes do not create competing automatic pushes. Provider failures retry
with exponential delay up to 60 seconds; new local saves wake the worker early.
Index failure does not prevent Git delivery; Git failure does not suppress
index work or roll back committed Markdown. Each successful provider generation
still corresponds to one immutable content snapshot.

Shutdown stops and joins the worker before closing index clients. Git subprocess
calls have a 45-second timeout each; no total delivery deadline is promised.
Neo4j provider timeout/connection limits and forced process termination remain
operational work. A graceful shutdown may wait for an in-flight provider call.
The restart tests use fault injection, not SIGKILL or power-loss tests.

## Deliberately opt in to outbound Git

No remote is discovered, pulled or merged at startup. First import/review an
existing wiki using the explicit [Git/import commands](managed-git-sync.md).
Automatic Git delivery is **outbound snapshot publication**, not multiwriter
synchronization. Configuring a reviewed existing remote commits to replacing its
selected Markdown set with the managed snapshot; review/import those contents
first. Files outside the prefix and non-Markdown files are preserved.

Example for a deliberately empty synthetic branch:

```sh
export SECOND_BRAIN_WIKI_GIT_SYNC=1
export SECOND_BRAIN_WIKI_GIT_REMOTE=/absolute/path/to/synthetic.git
export SECOND_BRAIN_WIKI_GIT_BRANCH=wiki
export SECOND_BRAIN_WIKI_GIT_PREFIX=notes
export SECOND_BRAIN_WIKI_GIT_EXPECTED_REMOTE_REVISION=empty
export SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/managed-vault
PYTHONPATH=backend/src backend/.venv/bin/python -m uvicorn \
  second_brain.wiki.api:app_factory --factory --host 127.0.0.1 --port 8000
```

For an existing branch, use its reviewed full 40-character commit hash instead
of `empty`. The first target configuration requires this explicit baseline.
Restart can omit the baseline or keep its **original** value: the durable ledger
tracks subsequent published heads. A different bootstrap value fails closed.
Targets are keyed by a hash of URL/branch/prefix; the delivery database stores no
URL or credentials. Transport authentication limits remain as documented in
[managed Git](managed-git-sync.md): SSH agent or credential-free HTTP(S), no
credential URL/helper provisioning. Demo startup overrides remote/provider flags
so an inherited production target cannot receive demo content.

Before network work, the worker durably records a frozen content/expected-head
payload and stable request ID. A lost response retries the old payload even if a
new local write has already happened; after recovery, a later pass publishes the
newer head. The underlying sync never uses a force push. Remote advancement,
deletion or rewind causes a persistent conflict; recovery that observes an
external descendant also blocks further publication rather than adopting it.

**Conflict handling is deliberately operator-controlled:** automatic publication
stays blocked, including after restart. Stop automatic delivery while reviewing
both snapshots; use explicit import/pull/export if remote changes belong in the
local wiki. Then acknowledge the reviewed local whole-wiki head and the actual
reviewed remote pointer:

```sh
PYTHONPATH=backend/src backend/.venv/bin/python -m second_brain.wiki.delivery_runtime --reconcile \
  --base-revision REVIEWED_MANAGED_HEAD --expected-remote-revision REVIEWED_REMOTE_HEAD
# For a deliberately reviewed missing branch, use --remote-empty instead.
PYTHONPATH=backend/src backend/.venv/bin/python -m second_brain.wiki.delivery_runtime --once
```

Keep the same explicit target environment above. Reconciliation only operates
on a blocked target, checks both heads again and never changes Markdown or
merges data. It durably prepares a new delivery epoch so old acknowledgements
cannot be reused after a branch deletion/rewind. A stale guard or unavailable
remote preserves the blocked state. It deliberately authorizes the **next**
normal snapshot push; no force push is added. Original bootstrap configuration
remains valid on restart. The CLI is an operator capability, not a browser/MCP
writing tool. Repeating an already completed reconciliation rejects safely;
read current status before another control action. Never delete ledgers or
change revisions blindly to bypass a conflict. Local saves/search continue.

## Status and UI

The status endpoint is authenticated by the same REST boundary, returns
`Cache-Control: no-store`, and makes no provider/remote request. Indexes report
`not_configured`, `pending`, `current` or `error`; remote additionally reports
`conflict`, last published content revision and last verified remote revision.
`cached_verification` means a past acknowledgement, never proof that the live
remote has not changed since. A new local write makes delivery pending.

After a browser save, the editor confirms local content, reads fresh workspace
status and polls pending work for at most 30 seconds. Errors/conflicts stop that
poll. It never replays a content write to refresh delivery status. Navigation
invalidates old status responses. Article contents and on-demand Git history
remain usable with unsaved editor drafts; history loading errors can be retried.

Verification on 2026-10-10: real temporary bare-Git delivery/restart/conflict tests,
transport worker lifecycle and cross-process write detection tests, separate
REST/MCP save/status agreement, and running-browser article/editor regression.
Hosted providers, production Git authentication, container deployment and forced
process recovery are not established by these tests.
