# Explicit managed Git snapshot sync

`second_brain.wiki.remote.ManagedGitSync` is an explicit Python API; invoking it
alone starts no worker, implicit merge, scheduler or deployment. Managed factories
can separately enable [recoverable delivery](managed-delivery.md). No remote URL
or credentials are persisted. Existing legacy Git workflows are separate.

```python
sync = ManagedGitSync(store, remote=caller_selected_target,
                      branch="wiki", prefix="notes")
publication = sync.push(base_revision=managed_snapshot_revision,
                        expected_remote_revision=reviewed_remote_revision_or_none,
                        request_id="stable-publication-id")
replacement = sync.pull(base_revision=managed_snapshot_revision_or_none,
                        expected_remote_revision=reviewed_remote_revision,
                        request_id="stable-import-id")
```

Push freezes the named managed snapshot and publishes only its `ID.md` pages.
The `.wiki-remote.git` object database is separate from `.wiki.git`: managed
parents, request receipts, page revision files, indexes, configurations and hooks
are never exported. Remote non-Markdown files and everything outside the chosen
prefix are preserved. Existing Markdown within the prefix is replaced as a full
snapshot; nested Markdown is flattened into `ID.md`. Duplicate page IDs, unsafe
paths, nonregular Markdown, invalid UTF-8 and oversized pages are refused.

The expected remote revision is explicit; `None` means an absent branch. The
prepared export commit has that remote revision as its sole parent. Publication
uses a normal fast-forward push, with no force option, lease, rebase, or automatic
retry against a new remote head. A fresh comparison happens immediately before
push. A further concurrent remote advance causes Git to reject the normal push.
A trusted, generated pre-push guard also compares Git's advertised remote object
ID with the expected revision before sending objects. It closes deletion or
rewind races between the explicit fetch comparison and advertisement. Git's
server-side old-object-ID comparison protects the subsequent update. This guard
is the only hook allowed for push; remote and user hooks are never inherited.
Deletion/recreation with a different head is a conflict.

SQLite stores request fingerprints and prepared commit IDs before attempting
publication. Prepared refs retain each request's objects through garbage
collection. Retry the same request ID with exactly the same managed revision,
expected remote revision and target. A lost acknowledgement can be recovered
when the fetched remote equals or descends from the prepared commit. Confirmed push acknowledgements are saved durably before return. Identical
retries return that original acknowledgement even when the target is unavailable
or subsequently rewritten. The result includes the content revision and request
ID. The receipt acknowledges that historical publication; it does not assert the branch still
points at that commit. A request ID reused for different arguments is refused.
The database stores fingerprints, not remote addresses or credentials.

Pull deliberately replaces the complete managed page set through `import_vault`.
It validates the remote head before freezing objects and requires the explicit
managed base revision (`None` is create-only). It retains local history and the
remote source parent. It never asks an LLM to merge. A successful import receipt
is resolved before live fetch on retry, preserving later local or remote edits
and returning the original publication revision. Empty-source replacement of a
populated vault is refused by the importer.

Returned remote metadata is a cached verification, never a live-current claim.
Errors and metadata contain neither remote URLs nor page bodies. Git subprocesses
have a 45-second execution timeout. On POSIX, timed-out Git and its SSH children
are killed as one isolated process group; pipe draining has a separate two-second
bound (plus at most two seconds to reap Git). CLI interruption also stops the
transport before propagating the interruption. Other platforms kill Git and bound
pipe draining, but descendant cleanup is not established there. A timed-out push
can still have published remotely: retry with the same request ID to resolve its
prepared receipt. This is not a total deadline for a multi-command delivery pass.

## Target and authentication limits

Choose a valid explicit branch and safe relative prefix. Absolute local paths
are accepted for controlled local use and tests; remote targets support HTTP(S),
SSH URLs with no username or username `git`, and `git@host:path` syntax. HTTP
userinfo, passwords, query strings, fragments, external transport helpers and
option-like targets are refused. URLs/remotes are never written to Git config.
Authentication supports an existing SSH agent through `SSH_AUTH_SOCK` and
credential-free HTTP(S). SSH is explicitly noninteractive, checks host keys
strictly, ignores user/system SSH configuration, disables default private
identity files and never forwards the agent. `~/.ssh/config` aliases, ports,
ProxyCommand and IdentityFile settings therefore do not apply: select the real
host/port in the SSH URL. Ambient Git configuration, credential helpers,
Git/SSH askpass programs and `GIT_SSH_COMMAND` are not inherited.

By default OpenSSH uses its normal known-hosts files. For an explicit trust
boundary pass `ssh_known_hosts="/run/wiki/known_hosts"` in Python,
`--ssh-known-hosts /run/wiki/known_hosts` to the CLI, or set
`SECOND_BRAIN_WIKI_GIT_SSH_KNOWN_HOSTS=/run/wiki/known_hosts` for runtime delivery.
The file must be an absolute regular nonsymlink file outside the managed vault;
control characters and SSH expansion characters (`%`, `$`, double quotes and
backslashes) are refused. Spaces are supported. Explicit trust disables the
global known-hosts file. Pin a host key using an independently verified provider
fingerprint, not an unverified network scan. Unknown or changed keys fail closed;
the application never accepts a host key on first use.

For container operation, load a narrowly scoped deploy key into a dedicated
host SSH agent, mount only its socket and the reviewed known-hosts file read-only,
and set the corresponding socket/trust paths in the backend container. Do not
mount a private key, the complete home directory or an SSH configuration. Keep
the socket/trust mounts outside the wiki volume so backups and exports contain
neither. Set outbound delivery variables explicitly as in the
[delivery guide](managed-delivery.md); the base preview Compose deliberately does
not inherit host SSH credentials or enable remote delivery. A mounted agent socket
still grants signing capability to that container: restrict its key to the chosen
repository and required branch permissions. The deploy key remains operator-owned;
no key provisioning or private HTTPS credential helper is provided.

## Explicit command-line workflow

With the backend environment active, set `PYTHONPATH=backend/src` from the checkout
root. Choose your own target and branch; this example uses a **disposable local
bare repository**, not an existing personal or production target:

```sh
git init --bare /absolute/path/to/synthetic-remote.git

python -m second_brain.wiki.git_cli --vault /absolute/path/to/managed-vault \
  --remote /absolute/path/to/synthetic-remote.git --branch wiki inspect

python -m second_brain.wiki.git_cli --vault /absolute/path/to/managed-vault \
  --remote /absolute/path/to/synthetic-remote.git --branch wiki push \
  --base-revision REVIEWED_MANAGED_HEAD --remote-empty --request-id first-push

python -m second_brain.wiki.git_cli --vault /absolute/path/to/new-managed-vault \
  --remote /absolute/path/to/synthetic-remote.git --branch wiki pull \
  --managed-empty --expected-remote-revision REVIEWED_REMOTE_HEAD \
  --request-id first-pull
```

The managed head comes from the snapshot graph's `revision` or the first-start
command. Review `inspect`'s `observed_remote_revision` before importing or updating.
An existing remote push requires `--expected-remote-revision` instead of
`--remote-empty`; an existing managed pull requires `--base-revision` instead of
`--managed-empty`. All guards and request IDs are required. Optional `--prefix`
scopes the remote Markdown folder; choose it deliberately because a push replaces
all Markdown within that scope. Reuse exact arguments after a lost response.

These commands do not start services, configure background sync, or deploy the
application. REST/MCP immutable mutation receipts retain their publication-time
state; current delivery status is available separately through the configured
[delivery coordinator](managed-delivery.md).

## Operational limits

Fetch transfers the selected branch's reachable Git objects. Pull constructs a
clean temporary checkout of that frozen remote commit; unrelated non-Markdown
files and symlinks can therefore be materialized temporarily, although none of
its hooks or configurations are copied or executed. Remote object history and
non-Markdown blobs do not have aggregate transfer/disk quotas. The one-megabyte
limit applies to Markdown pages. Use trusted, appropriately sized targets.
No automatic receipt/object retention cleanup is implemented. Back up both the
managed vault and its isolated remote state for restart recovery.

Tests use only synthetic Markdown and temporary local bare remotes. They cover
lost acknowledgements, restart, prepared retries, edits during push, forward
conflicts including the comparison/push race, branch deletion/recreation,
explicit pull guards and retries, object retention, target validation, duplicate
IDs, and the absence of managed-internal objects from exported history. Synthetic
process tests additionally verify actual pipe-holding descendant cleanup and
sanitized timeout errors. An actual OpenSSH `-G` check verifies noninteractive,
agent-only identity configuration and explicit trust-path quoting. It does not
establish an authenticated connection to a private hosted repository.

## Runtime delivery

The explicit CLI remains available. Managed server factories can now publish
after saves through [recoverable delivery](managed-delivery.md), only after an
explicit target/baseline opt-in. No automatic pull or merge is added. Persistent conflicts block automatic writes until deliberate reviewed operator
reconciliation; see its guarded CLI and remaining production limits.
