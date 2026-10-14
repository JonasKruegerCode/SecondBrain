# Back up and restore a managed wiki

The managed wiki has an explicit portable backup format. It preserves the
authoritative Markdown/Git history, durable request receipts, local index and
delivery ledgers, and the optional demo marker. It does **not** include external
Neo4j or Qdrant data, provider credentials, environment variables, proxy
configuration, or a remote Git repository. Those remain independent deployment
concerns; derived indexes are rebuilt against the restored content revision.

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

Start the API against the restored path, inspect `/api/wiki/health`, open several
pages and history entries, and run one delivery pass after configuring the same
optional providers:

```sh
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/restored-vault \
  "$WIKI_PYTHON" -m second_brain.wiki.delivery_runtime --once
```

Index receipts that do not match the restored content are reported as pending and
rebuilt. Remote delivery configuration and credentials come from the deployment
environment; they are deliberately not placed in the archive. Review remote state
before re-enabling a target after disaster recovery. Do not use restore as an
implicit merge or rollback over a live vault.

## Current verification boundary

The native synthetic regression covers populated and empty archives, full local
history, request-receipt replay after restart, both SQLite ledgers, demo metadata,
checksum/member validation, refusal to overwrite, and the real CLI round trip.
Truncated gzip streams, invalid trailers and manifests are rejected before
publication; CLI failures return structured `backup_invalid` errors. Valid plain
tar, gzip, bzip2 and xz archives retain their existing restore support.
The separate [disposable stack acceptance](managed-stack-acceptance.md) covers
container invocation and named-volume recovery with synthetic content. Neither
that isolated stack nor the native test establishes production reverse
proxy/HTTPS, external provider reconstruction, or a real off-host disaster restore.
