# Plain Markdown export

Run from the backend environment with an explicit vault, output directory and
expected whole-vault revision (the `revision` returned by `WikiStore.snapshot()`):

```sh
python -m second_brain.wiki.exporter --vault /path/to/vault \
  --destination /path/to/plain-wiki --base-revision COMMIT_SHA
```

For an empty vault pass `--base-revision ''`. The equivalent Python API is
`export_vault(store, destination, base_revision=revision)`.

The output contains only root-level `PAGE_ID.md` files from one captured snapshot.
UTF-8 bytes, Unicode, front matter, links and CRLF line endings are preserved.
Deleted pages are absent. Git history, `.wiki.git`, request receipts, revision
metadata, import records, indexes and credentials are excluded. This is a plain
Markdown export, not a backup of history or application state.

Choose a new or existing empty directory whose parent already exists. Existing
nonempty directories are always refused, even when identical to a prior export.
Symlink paths and destinations overlapping the managed vault are refused.
Run the command in a trusted parent directory: protection against another user
replacing ancestor directories is outside this local export contract.

All content is prepared in a temporary sibling directory and published with one
atomic Linux `renameat2(RENAME_NOREPLACE)`. Unsupported hosts fail closed. An
existing empty destination is removed immediately before publication, so it may
briefly be absent; a failed publication restores it when no other writer has
claimed the path. Concurrently created outputs are never overwritten. Failed
preparation leaves the destination untouched and removes temporary content.

A vault write after snapshot capture does not change this export. The JSON result
reports the captured `revision` and `page_count`; it does not claim that revision
is still the latest. A stale expected revision at capture fails without exporting.
Use a fresh destination for each subsequent export.
