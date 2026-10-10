# Import a local Git wiki into the managed profile

The explicit importer brings a committed Markdown snapshot into the standalone managed wiki. It leaves the source working repository unchanged and retains its original Git commit objects and ancestry in the target repository. It does not connect a remote, migrate the legacy memory service, or run automatically on startup.

The first stage supports **a clean local Git working repository**. A plain folder, a bare repository, and a dirty working tree are not supported source formats. An empty repository created with `git init` is allowed even before its first commit when importing without a prefix into never-published storage. Shallow, partial, or promisor repositories are refused: source history must be complete and locally available.

## Select and review the snapshot

Choose a source repository and an optional directory prefix, such as `1_knowledge/wiki`. A supplied prefix must exist in the committed tree; a typo is refused rather than treated as an empty snapshot. The importer reads the committed source SHA, not whatever bytes happen to be in the working tree. Commit intended changes first and check that `git status --porcelain` is empty. Tracked changes, staged changes, and untracked files cause refusal. Existing ignored working-tree files are not part of the committed snapshot.

All Markdown files under the prefix become managed pages. Each page ID is its filename without `.md`; nested directories are flattened into those IDs. For example, `1_knowledge/wiki/astronomy/sky.md` becomes `sky`. Two files with the same basename are ambiguous and cause refusal, even if they live in different folders. Links are preserved as written; the importer does not rewrite their destinations.

The complete input is validated before publication. Unsafe page IDs, symbolic-link pages, invalid UTF-8, and pages larger than the managed store's limit are refused. Markdown preserves its original UTF-8 bytes, including Unicode and CRLF line endings. Non-Markdown files are excluded from the managed page set while remaining available in the retained original source history. The original source commit and its complete reachable history are retained, including material **outside the selected prefix**. The prefix controls visible pages, not the scope of source history preserved in Git. Choose a separate, sanitized source repository if that history should not enter the managed destination.

The source and target directories must be separate and must not contain one another. Use a dedicated managed target, not a `.wiki.git` directory placed inside the source repository.

## Initial import from the CLI

From the repository root, activate the backend Python environment or set `PYTHONPATH=backend/src`. Choose a reviewed source and a new managed target:

```bash
export PYTHONPATH="$PWD/backend/src"
python -m second_brain.wiki.importer \
  --source /absolute/path/to/source-repository \
  --vault .managed/wiki \
  --prefix 1_knowledge/wiki \
  --empty \
  --request-id reviewed-initial-import-001
```

`--empty` authorizes only an initially empty managed snapshot. It cannot overwrite an already published snapshot. A successful response reports `publication: imported`, the new managed `revision`, the number of `pages`, and `source_revision` (the original source commit SHA, or `null` for an unborn repository). Graph/vector index status remains pending and remote sync is not configured in this local profile.

The Python entry point is `import_vault(store, source, prefix="", base_revision=None, request_id="...")`. Use `WikiStore` for the explicitly selected managed destination. `base_revision=None` corresponds to the CLI's `--empty` guard.

## Replace an existing managed snapshot

An import replaces the **entire managed page set** with the selected source snapshot. Pages not present in that snapshot are removed from the current view; prior managed snapshots remain in Git history. A zero-page import into a destination that currently contains pages is refused, so an empty selection cannot erase its content. Zero-page imports are permitted when the current page set is empty; a previously published empty snapshot still requires its exact HEAD as the expected base. The prefix limits the imported source, not which existing managed pages may be replaced.

Before replacement, inspect the target and record its current snapshot HEAD. You can inspect it with `git --git-dir=.managed/wiki/.wiki.git rev-parse refs/heads/wiki` or the current backend primitive `store._head()`. Pin that exact value with `--base-revision` for the reviewed operation:

```bash
python -m second_brain.wiki.importer \
  --source /absolute/path/to/source-repository \
  --vault .managed/wiki \
  --prefix 1_knowledge/wiki \
  --base-revision PASTE_THE_REVIEWED_MANAGED_SNAPSHOT_SHA \
  --request-id reviewed-replacement-import-002
```

This value is the managed **snapshot HEAD**, not a page's revision token. If another writer saves while the import is being prepared, publication fails with a conflict and that writer's snapshot remains current. Review the new state before submitting a new operation. Do not automatically read a newer HEAD and blindly retry a replacement.

## Retry and interruption behavior

Keep a stable `request_id` for one operation, with the same source commit, prefix, and expected base. The successful operation stores its receipt atomically with the snapshot. If a reply is lost after publication, retrying that operation—even after a process restart or a later save—returns the original receipt without publishing again. Reusing the ID for a different payload is refused.

A failure before the atomic Git ref update leaves the old complete snapshot visible. A failure after that update leaves the new complete snapshot visible and its receipt recoverable. Readers never see a partial set of imported pages. Concurrent foreign saves use the same publication boundary and cannot be overwritten using a stale base.

For a retry, keep the source repository on the same reviewed commit and clean. If the source has advanced, that is a new payload: inspect it, review the target again, and choose a new request ID.

## After import

Run the standalone wiki API against the managed destination, using the factory entry point described in [demo-start.md](demo-start.md). The page history combines managed edits with original source commits, using the preserved source-path mapping even for nested pages. Edit imported pages through the managed wiki or its normal save API. The source repository is a preserved import source, not a second writer for the managed store. Subsequent source changes appear only through another explicitly reviewed import.
