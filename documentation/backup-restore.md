# Back up and restore a managed wiki

The managed wiki has an explicit portable backup format. It preserves the
authoritative Markdown/Git history, durable request receipts, local index and
delivery ledgers, and the optional demo marker. It does **not** include external
Neo4j or Qdrant data, provider credentials, environment variables, proxy
configuration, or a remote Git repository. Those remain independent deployment
concerns; derived indexes are rebuilt against the restored content revision.

Browser chat history and the saved start-page preference are also outside this
archive: restoring a server vault does not restore them. Saved chats live in the
browser's IndexedDB; unsaved fallback conversations last only in the current tab
and do not survive reload. Retained legacy `localStorage` chat backups are not
included or kept in sync with current chats. Deleting a conversation in Chat does
not erase those legacy copies; see the [PWA privacy guide](pwa.md).

## Create a backup

The commands below address a host directory. For the named volume used by
`docker-compose.wiki.yml`, use the [container backup and independent-volume
recovery procedure](install-update.md); the host does not automatically have an
equivalent `/managed-vault` directory.

Run all commands from the repository root. Prepare the locked backend and select
Poetry's actual Python rather than assuming an activated shell or `.venv` path:

```sh
(cd backend && poetry sync --no-interaction)
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
export PYTHONPATH="$PWD/backend/src"
"$WIKI_PYTHON" -m second_brain.wiki.backup create \
  --vault /absolute/path/to/managed-vault \
  --archive /absolute/path/to/backups/wiki-2026-10-10.tar.gz
```

The archive path must be new and outside the vault. SQLite ledgers use SQLite's
online backup API. They are captured before the Git bundle, so managed revisions
referenced by a captured ledger remain reachable from the bundled content head.
The command excludes transient lock files and never copies provider-owned index
storage. Its manifest records the exact content revision, page count, byte sizes,
and SHA-256 checksums.

The command is designed to tolerate ordinary concurrent page writes: it captures
one named Git revision, not a half-written working tree. For a release backup,
still quiesce writers and delivery workers so the archive and the separately
recorded provider/remote state describe the same operational moment.

If a save lands between reading the content head and creating its Git bundle,
the command fails with `backup_changed` and publishes no archive. The live wiki
and its saved edit remain intact. Retry the same new archive path after the save
has completed, or quiesce writers for the release backup. A save after bundle
capture can instead leave a valid archive of the earlier revision: the manifest
identifies that captured snapshot, not the latest state at command exit.

## Restore without overwriting

Restore only into a new path:

```sh
"$WIKI_PYTHON" -m second_brain.wiki.backup restore \
  --archive /absolute/path/to/backups/wiki-2026-10-10.tar.gz \
  --vault /absolute/path/to/restored-vault
```

Restore reads the compression stream through its end and validates the manifest
shape/encoding, member allowlist, checksums, Git bundle, Git object graph,
content revision, page count, and local SQLite integrity before publishing the
new directory. An existing destination is refused, so recovery never overwrites
the source vault. A failed restore leaves no partially published destination.

First start a loopback inspection service with background delivery, outbound Git,
optional index providers and chat explicitly disabled. These command-scoped
settings override inherited deployment flags; stopping the service ends this
inspection. Do not reconnect a production proxy or clients yet.

```sh
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/restored-vault \
SECOND_BRAIN_WIKI_DELIVERY=0 \
SECOND_BRAIN_WIKI_GIT_SYNC=0 \
SECOND_BRAIN_WIKI_GRAPH_INDEX=0 \
SECOND_BRAIN_WIKI_VECTOR_INDEX=0 \
OPENROUTER_API_KEY= \
  "$WIKI_PYTHON" -m uvicorn second_brain.wiki.api:app_factory \
  --factory --host 127.0.0.1 --port 8000
```

Inspect `/api/wiki/health`, pages, history and graph before any delivery work.
The existing REST API key still applies if configured. This disables external
work, not local editing: keep other writers stopped and do not change the vault
during inspection. Lexical search and the Markdown graph remain available.

After inspection, stop that service and deliberately configure only the optional
index providers you want to rebuild. Keep outbound Git disabled for this manual
pass:

```sh
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/restored-vault \
SECOND_BRAIN_WIKI_GIT_SYNC=0 \
  "$WIKI_PYTHON" -m second_brain.wiki.delivery_runtime --once
```

`SECOND_BRAIN_WIKI_DELIVERY=0` controls the background worker only; it does not
suppress an explicit `--once`. The separate Git flag is therefore required here.
Review the remote and its recovery boundary below before enabling Git delivery.

Index receipts that do not match the restored content are reported as pending and
rebuilt. Remote delivery configuration and credentials come from the deployment
environment; they are deliberately not placed in the archive. Review remote state
before re-enabling a target after disaster recovery. The archive preserves the
local delivery ledger but deliberately excludes the transport's
`.wiki-remote.git` prepared objects and `.wiki-remote.sqlite3` push receipts.
Consequently, a push that reached the remote but lost its acknowledgement before
backup cannot be automatically confirmed from this archive alone. A delivery
pass blocks with a remote conflict rather than guessing that publication
succeeded or overwriting the remote. If a newer local edit was captured, one pass
may first clear the older pending payload before the next pass reports that
conflict. Inspect both content revisions and the observed remote head, then use
the explicit [delivery reconciliation procedure](managed-delivery.md). A remote
descendant remains untouched while the target is blocked. Local page-mutation
receipts described below are preserved independently of transport receipts.
Do not use restore as an implicit merge or rollback over a live vault.

## Verify an uncertain save after recovery

A restored mutation receipt confirms a **historical publication**, not that the
page still has those contents. Test this first on an isolated synthetic vault:

1. Save a known edit and retain its original `request_id`, `base_revision`,
   Markdown payload and successful receipt. Keep these private when using real
   content; the backup contains receipts but does not restore a browser draft.
2. Quiesce writers and workers, create the archive, restore into a new path and
   start the API against that path. Compare current pages, revisions, history
   and explicit graph links before attempting delivery or cutover.
3. Replay the identical request against the restored API. It must return the
   original receipt, with no new content revision or history entry. Do not
   replace its base revision or request ID just because the service restarted.
4. Check the current page separately. A later saved edit must remain current;
   replaying an old create receipt must not resurrect a subsequently deleted
   page. Reusing the request ID with changed content must fail with
   `request_id_reused`; a new request against an outdated base must fail with
   `revision_conflict`.

For an open browser whose save acknowledgement was lost, leave the unchanged
draft in that same tab and use **Save changes** again after service recovery.
The editor retains that attempt's immutable request identity. A successful retry
can confirm the original save without applying it twice. After acknowledgement,
the editor separately reads the current page. A newer revision, deletion or
unavailable/invalid read keeps the same draft and explains that the earlier save
was confirmed. It does not silently adopt a newer base revision. Copy any local
text you need, then choose **Cancel** to review the current page through a fresh
read. An unavailable read can instead be retried by saving the unchanged draft.
Reloading or closing the tab can discard the draft and retry state; a server backup is not browser
storage recovery. Read the latest page before reconciling any later edit.

## Current verification boundary

The native synthetic regression covers populated and empty archives, full local
history, request-receipt replay after restart, both SQLite ledgers, demo metadata,
checksum/member validation, refusal to overwrite, and the real CLI round trip.
Two concurrent-save cases hold only the Git-bundle boundary while a real REST
edit completes on another thread. They check rejection with no archive or
temporary debris, a deliberate successful retry, and restoration of one exact
revision's page, history and graph. Replaying its original REST request leaves
the restored head unchanged. This is local Git/SQLite/ASGI evidence, not an
off-host recovery or a simultaneous snapshot of external providers.
An additional native Chromium rehearsal uses the real loopback HTTP service and
CLI backup/restore. It checks identical decoded receipt text for save, create and
delete; unchanged current pages/history/graph and Git head; both 409 failures;
and an old save retry after a later edit and another service restart. At
390/1440 pixels, a separate browser probe injects HTTP 504 **after** a real
successful upstream save. The same document and editor retain the draft while
the demo services stop and restart on the restored vault; retry sends the
identical request text and confirms the original receipt without a second
publication. Demo mode already disables development hot reload. This is
controlled acknowledgement-failure injection, not a dropped-TCP, browser-restart,
power-loss, external-provider or physical-device test.
Corrupt source SQLite headers or b-tree pages stop backup creation with
`invalid_vault`; no archive is published and source bytes remain unchanged.
SQLite busy/full/I/O failures retain a separate `storage_unavailable` result.
Vault and restore paths containing spaces, Unicode, `?`, `#`, or literal percent
escapes preserve their ledgers and leave no stray files. Checksum-valid archives
with malformed SQLite metadata fail before publication with a structured
`backup_invalid` CLI error.
Truncated gzip streams, invalid trailers and manifests are rejected before
publication; CLI failures return structured `backup_invalid` errors. Valid plain
tar, gzip, bzip2 and xz archives retain their existing restore support.
Native bzip2 stream corruption also returns `backup_invalid`, while filesystem
errors carrying an errno remain `storage_unavailable`. These error-contract
checks include temporary-directory cleanup; they are not disk-failure recovery
or repair of damaged metadata.
The separate [disposable stack acceptance](managed-stack-acceptance.md) covers
container invocation and named-volume recovery with synthetic content. Neither
that isolated stack nor the native test establishes production reverse
proxy/HTTPS, external provider reconstruction, or a real off-host disaster restore.
