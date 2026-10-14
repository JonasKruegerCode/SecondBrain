# Install, update and recover the managed Compose preview

Use a reviewed source revision and the managed Compose file. This guide prepares
an operator procedure; it does not authorize a production deployment or migrate
an existing legacy vault. Docker Engine and Compose v2 are required for runtime
commands. Start with the [first-start choices](first-start.md), keep the existing
authenticated HTTPS proxy, and use the [MCP guide](managed-mcp.md) for its separate
Bearer/Host/Origin boundary.

## Keep one installation identity

Run from the root of a clean checkout of the reviewed `secondbrain-2.0` revision.
Record its full commit with `git rev-parse HEAD`. Check `git status --short` before
changing revisions; preserve local work rather than overwriting it.

For a **new** installation choose one project name:

```sh
export WIKI_PROJECT=secondbrain-wiki
wiki_compose() {
  docker compose -p "$WIKI_PROJECT" --env-file .env.wiki \
    -f docker-compose.wiki.yml "$@"
}
```

For an **existing** installation, use its actual project name instead. Inspect
the `com.docker.compose.project` container/volume labels if necessary. Do not
adopt this example name over an existing installation: the named `managed_wiki`
volume is project-prefixed, so a different project can appear to be an empty wiki.
Keep this project name, Compose files, environment file and volume mapping for
every start, backup and update. An explicit volume `name:` override also matters.
If using the [proxy-network override](../README.md#docker-compose-preview), add
its `-f` argument to this function and retain it throughout the procedure.
Use distinct proxy-network aliases for each installation; route to those aliases
rather than a generic `frontend` or `mcp` name shared by several projects.

Copy `.env.wiki.example` to the ignored `.env.wiki` only on initial setup. Set a
real MCP secret and exact proxy authorities/origins. The browser API does not
receive the MCP Bearer key; protect frontend, assets and `/api/wiki` with the
existing proxy authentication. Configure OpenRouter only if paid chat is wanted.
The base managed Compose profile does not enable optional index/remote-Git
providers; configuring those is a separate reviewed operator step.

Check interpolation without printing secrets, then build and start:

```sh
wiki_compose config --quiet
wiki_compose build backend mcp frontend
wiki_compose up -d --no-build --wait
wiki_compose ps
```

The preview binds frontend to `127.0.0.1:8080` and MCP to `127.0.0.1:3001`.
A new volume starts empty; services never auto-seed it. Backend health means the
local content authority is readable, not that model, index or remote delivery is
accepted. `--wait` does not replace checking frontend/MCP through the actual proxy.
Keep unrelated legacy/production services and volumes separate. Ordinary
`stop`/`start` retains this content. **Do not use `down --volumes` or volume prune
for an update:** that can delete the persistent wiki.

## Prepare an update and archive current content

Finish or preserve browser drafts and pending replies first; quiesce external
writers. Record the current source commit, Compose/env/proxy configuration and
actual image IDs. Protect environment/proxy credentials separately: the wiki
archive does not contain them. Retain the old images locally with distinct tags
before rebuilding, so a later recovery need not recreate them from mutable bases.
For example, obtain each running image ID with:

```sh
docker inspect --format '{{.Image}}' "$(wiki_compose ps -q backend)"
docker inspect --format '{{.Image}}' "$(wiki_compose ps -q mcp)"
docker inspect --format '{{.Image}}' "$(wiki_compose ps -q frontend)"
```

Stop all managed writers and create a new archive through a one-off backend
container. The service volume remains mounted even when its regular container is
stopped. Run this **before** changing the source revision or image selection:

```sh
umask 077
mkdir -p .demo/operator-backups
WIKI_ARCHIVE="wiki-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
wiki_compose stop frontend backend mcp
wiki_compose run --rm --no-deps -T \
  -v "$PWD/.demo/operator-backups:/backups" \
  backend python -m second_brain.wiki.backup create \
  --vault /managed-vault --archive "/backups/$WIKI_ARCHIVE"
```

Require a successful CLI result and retain its exact content revision/page count.
The archive must be new and outside the vault. Container-created files may be
owned by root; restrict directory access and use the operator's appropriate
permissions to inspect/copy them. Copy the archive to protected storage outside
this checkout and host before treating it as a disaster-recovery backup. If backup
fails, resolve it before updating; the unchanged current configuration can be
started again with `wiki_compose up -d --no-build --wait`.

## Apply a reviewed application version

Select the reviewed source commit in the clean checkout, retaining the existing
ignored environment, overrides and project identity. Build all three services
from that version. Backend and MCP share one authority and must be compatible;
avoid a prolonged mixed-version writer deployment.

For a frontend update requiring an in-app notice, ensure the reviewed version
changes the bytes of `frontend/public/service-worker.js`, including its `RELEASE`
value. A change only to other assets does not create a waiting worker. This is a
manual release requirement, not an automatic build stamp. Then:

```sh
wiki_compose config --quiet
wiki_compose build backend mcp frontend
wiki_compose up -d --no-build --wait
wiki_compose ps
```

`up` recreates changed services while preserving mounted volumes. `restart`
alone does not apply changed images, environment or Compose configuration. A
reviewed Git commit pins application source, not every build input: Docker base
tags and apt repositories remain mutable. Record the resulting image IDs; an
older-source rebuild is not proof of the identical former image.

Published application images are an alternative **only when those exact artifacts
exist and their provenance is reviewed**. PR image builds do not publish this
branch; do not substitute `latest` from the default branch. Use a local override
with concrete reviewed digests/retained image IDs for all services:

```yaml
services:
  backend:
    image: ${WIKI_BACKEND_IMAGE:?Select the reviewed backend image}
  mcp:
    image: ${WIKI_MCP_IMAGE:?Select the matching reviewed MCP image}
  frontend:
    image: ${WIKI_FRONTEND_IMAGE:?Select the reviewed frontend image}
```

Add this override's `-f` argument to `wiki_compose`, set the three selections in
the protected environment, and check `config --quiet`. For registry digests,
explicitly `wiki_compose pull backend mcp frontend` first. For retained local
images, do not pull. In either case use
`wiki_compose up -d --no-build --pull never --wait`; the inherited build entries
are not used. Do not mix this image-selected route with the source build command.

## Check service and browser recovery

Through the actual authenticated HTTPS host, check anonymous denial for the wiki,
API, manifest and worker; authenticated Home/article/history access; a deliberate
revisioned edit/retry; and MCP initialize/read with its separate credentials.
Compare content revision/history with the backup and expected later edits. Check
optional index/delivery receipts independently before claiming those targets fresh.

Keep an already open browser tab for the PWA check. Compare served worker bytes
with the previous release, bring the app to the foreground and inspect **Update
now**. An unsaved editor, pending save, unsent chat or pending reply should block
reload. Finish/save or deliberately discard before updating; check another dirty
tab also preserves its draft. After safe activation, confirm controlled reload,
saved Home, direct URLs and readable current content. A clean navigation receiving
new HTML is not by itself proof that the protected PWA update path ran.
Use the [PWA guide](pwa.md) for installation, privacy and precise limits. Physical
Home Screen/standalone/touch checks remain separate from browser emulation.

## Recover without overwriting current content

If service verification fails, retain diagnostics and archive any post-update
content before recovery. Select the previously recorded actual images using the
image override, **after** checking that they can read the current store format.
Use the same project and volume; switching application images does not undo wiki
edits. Revalidate auth, content/history and service/worker behavior. An old worker
also needs different bytes to be an update; do not clear browser storage to force
one, because that can erase locally stored conversations and the saved start page.

If content restoration is required, restore the chosen archive into an independent
new volume/path and inspect it before routing users or writers there. Select a
unique new volume name and the reviewed restore-capable backend image. For example:

```sh
: "${WIKI_RECOVERY_VOLUME:?Choose a new recovery volume name}"
: "${WIKI_BACKEND_IMAGE:?Select the reviewed backend image}"
docker volume create "$WIKI_RECOVERY_VOLUME"
docker run --rm --network none --entrypoint python \
  -v "$WIKI_RECOVERY_VOLUME:/recovery" \
  -v "$PWD/.demo/operator-backups:/backups:ro" \
  "$WIKI_BACKEND_IMAGE" -m second_brain.wiki.backup restore \
  --archive "/backups/$WIKI_ARCHIVE" --vault /recovery/restored
```

Restore refuses an existing `restored` destination. Do not remove an earlier
recovery to make this command pass; choose another new destination instead. To
inspect the recovered wiki through Compose, deliberately select this volume and
subdirectory with an override:

```yaml
services:
  backend:
    environment:
      SECOND_BRAIN_WIKI_VAULT: /managed-vault/restored
  mcp:
    environment:
      SECOND_BRAIN_WIKI_VAULT: /managed-vault/restored
volumes:
  managed_wiki:
    external: true
    name: ${WIKI_RECOVERY_VOLUME:?Select the independently restored volume}
```

Use a separate inspection project with separate loopback ports and no public
proxy attachment; verify reads/history/receipts before a deliberate cutover. Do
not start that inspection with the original fixed ports or expose two writers to
the same vault. Retain both the original volume and the recovery until accepted.
The
[backup/restore guide](backup-restore.md) explains the create-only restore and
provider/remote boundaries. Never restore over the live source or silently discard
post-backup edits. An incompatible old image is not a safe rollback just because
it once ran.

## Evidence boundary

The [disposable stack acceptance](managed-stack-acceptance.md) builds source and
checks real container restart, shared REST/MCP writes, synthetic HTTPS/auth,
address recovery and independent-volume restore. Browser acceptance separately
checks worker transitions and draft/reply guards. Neither proves this operator's
proxy, private content, published image availability, production upgrade or
physical installation. Inspect the reviewed revision's actual CI records and
perform the deployment-specific checks before release signoff.

Compose behavior: [project names](https://docs.docker.com/compose/how-tos/project-name/),
[network aliases](https://docs.docker.com/reference/compose-file/services/#aliases),
[up](https://docs.docker.com/reference/cli/docker/compose/up/),
[restart](https://docs.docker.com/reference/cli/docker/compose/restart/) and
[run](https://docs.docker.com/reference/cli/docker/compose/run/).
