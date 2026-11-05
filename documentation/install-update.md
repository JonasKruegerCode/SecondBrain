# Install, update and recover SecondBrain

The [README](../README.md#install-with-docker) is the short installation path:
copy `docker-compose.yml` and `.env.example`, configure `.env`, then pull/start.
Only Docker Engine with Compose v2 is needed on the host. The base Compose has
**no build context, host startup script, worker/Redis/Jaeger service or old UI**.
The backend image's normal command is the current REST factory; the MCP service
uses its own native factory from that same image. Do not add `run-managed.py`.

## Network and authentication

| Route | Default destination | Authentication |
| --- | --- | --- |
| Browser, assets, manifest, worker and `/api/wiki/*` | `127.0.0.1:8080` → frontend:80 | Existing authenticated HTTPS proxy |
| REST upstream | backend:8000, Docker network only | Same-origin browser proxy; not exposed directly |
| Streamable MCP `/mcp` | `127.0.0.1:3001` → mcp:3001 | MCP secret plus Host/Origin allowlists |

`WIKI_FRONTEND_PORT` and `WIKI_MCP_PORT` configure host ports. A nonempty
`WIKI_MCP_PORT` wins over `MCP_PORT`, then 3001. An existing `MCP_PORT=3000`
therefore preserves that host port; the MCP container listens on 3001.
The browser/API does not receive the MCP key. Preserve the public Host header
through the frontend proxy: changing it can make writes fail `origin_rejected`.
Forward MCP authorization and configure its actual incoming Host and allowed
HTTPS Origins. The service is not an OAuth authorization server.

For a reverse proxy in Docker, loopback host ports are not its own loopback.
Attach `frontend` and `mcp` to the existing proxy network via an operator-owned
Compose override, using distinct aliases per installation, or route through a
reachable host gateway. Keep the internal default network too. Route the web
host to frontend:80 and the MCP host to mcp:3001, with existing authentication
and TLS. A changed upstream requires updating the existing route; this does not
mean another reverse-proxy installation is needed. Never publish an unauthenticated
browser/API on a public interface.

## Content, Git and providers

A new instance uses `managed_wiki:/managed-vault`. Without a Git URL it starts
empty. It never automatically seeds an existing nonempty vault. Optional template
and explicit import commands are in [first start](first-start.md).
`VAULT_GIT_URL` / existing `VAULT_GITHUB_URL` enables automatic startup import and
subsequent pull/integration/commit/push. Existing auth aliases remain supported.
Choose the content folder deliberately: `SECOND_BRAIN_WIKI_GIT_PREFIX` defaults
to `1_knowledge/wiki`; an empty value selects repository root. See
[Git delivery](managed-delivery.md) for conflicts, credentials and retry.
Mount explicitly selected SSH key/trust files read-only; no host script is needed.

Without model/index settings, article/editor/history, explicit links, local graph
and lexical search work. Configure OpenRouter for paid chat, and reachable
Neo4j/Qdrant endpoints for the optional indexes. The same settings reach REST
and MCP; only REST owns the background Git/index loops. Health checks verify
local storage, not completed indexing or provider quality. Use the index/delivery
status tools independently. Never paste secrets into logs or print resolved
Compose configuration; `docker compose config --quiet` checks it silently.

## Optional index databases

Use existing reachable database endpoints, or copy `docker-compose.indexes.yml`
alongside the base file. Set `NEO4J_PASSWORD` and the chosen embedding provider key
in `.env`, then run:

```sh
docker compose -f docker-compose.yml -f docker-compose.indexes.yml up -d --wait
```

This adds only Neo4j and Qdrant, with private persistent volumes and no public
ports. It sets internal endpoints in both app processes. Set
`SECOND_BRAIN_WIKI_VECTOR_INDEX=0` to defer paid embeddings. The graph/vector
adapters and GraphRAG tools remain part of the app; removing Celery does not
remove these features. Consult [index operation](managed-indexes.md).

## Source builds and native development

From a complete checkout with `.env` configured:

```sh
docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build --wait
```

Both Docker paths run Python/Poetry/Node inside build/runtime images. Native
host dependencies are needed only for the [development/demo](managed-wiki-development.md)
path. The source overlay chooses local `:dev` image tags and build contexts;
never copy it into an image-only installation. `restart` alone does not update
images, environment or Compose configuration.

## Existing installations and breaking changes

This is a deliberate removal of the old application entry, old UI, ingestion/
repair, `remember`/`recall`, old REST routes and Celery/Redis/telemetry runtime.
New backend images default to the Managed REST API, not the old combined MCP
server. Clients must use `/api/wiki/*` and current MCP tools; current key/Git
configuration compatibility is retained. The obsolete root Compose command that
copied `legacy.html` over `index.html` must be removed by adopting this reviewed
Compose, not preserved as a custom override.

**Before merging/updating shared `latest` consumers:** identify old installations,
retain their exact running image IDs/digests and Compose/env files, and arrange
their deliberate switch. A worker still launching Celery or a frontend still
copying removed `legacy.html` cannot run against the new images. Pin an unconverted
installation to its retained old images; do not automatically replace its config.
Changing image tags is not a data migration. No other instance is changed by
preparing this PR.

Preserve the actual Compose project, volume and vault subdirectory. The new
base uses a project-prefixed `managed_wiki` volume. If your existing Managed data
is elsewhere, map that exact volume and path in a local override **for both**
backend and MCP before starting. For example, an existing volume `existing_vault`
with a managed store at `/vault/.managed-wiki` can be selected explicitly:

```yaml
services:
  backend:
    environment:
      SECOND_BRAIN_WIKI_VAULT: /managed-vault/.managed-wiki
  mcp:
    environment:
      SECOND_BRAIN_WIKI_VAULT: /managed-vault/.managed-wiki
volumes:
  managed_wiki:
    external: true
    name: existing_vault
```

Use the real name and subdirectory, not these example values. Keep only one
writer deployment on a vault; stop the prior app's writers for a deliberate
cutover. Do not delete volumes, user directories, `.env`, or unrelated services.
The old raw-Markdown layout is not interchangeable with the Managed store;
import it deliberately with the existing Git/import tools when needed.
The current browser/MCP proxy routes and auth are retained or explicitly
retargeted; no deployment is performed by the cleanup PR.

For the remaining examples, use one fixed installation identity:

```sh
wiki_compose() { docker compose --env-file .env -f docker-compose.yml "$@"; }
```

Add your actual `-p` project name and every required local override to this
function and keep them throughout the operation. Do not introduce a new project
name over existing data. Normal `stop`/`start` and `up` retain volumes;
`down --volumes` deletes nonexternal persistent data and is not an update.

## Prepare an update and archive current content

Finish or preserve browser drafts and pending replies first; quiesce external
writers. Browser chat history and the saved start-page preference are outside
the server wiki archive. Unsaved chat fallback lasts only in its current tab;
recover storage and save it, or deliberately delete its unsaved messages, before
reloading. Record the current source commit, Compose/env/proxy configuration and
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
  backend sh -c 'exec python -m second_brain.wiki.backup create \
    --vault "${SECOND_BRAIN_WIKI_VAULT:?Set the active managed vault}" \
    --archive "$1"' sh "/backups/$WIKI_ARCHIVE"
```

The vault path expands inside the one-off container, using the service environment
including any recovery override such as `/managed-vault/restored`. The archive
path is passed as a quoted argument from the host shell.

Require a successful CLI result and retain its exact content revision/page count.
The archive must be new and outside the vault. Container-created files may be
owned by root; restrict directory access and use the operator's appropriate
permissions to inspect/copy them. Copy the archive to protected storage outside
this checkout and host before treating it as a disaster-recovery backup. If backup
fails, resolve it before updating; the unchanged current configuration can be
started again with `wiki_compose up -d --no-build --wait`.

## Apply a reviewed application version

Select the matching reviewed images, retaining the existing protected environment,
overrides and project identity. Pull the backend/MCP/frontend pair before replacing
services. For source builds, add docker-compose.source.yml explicitly. Backend and MCP share one authority and must be compatible;
avoid a prolonged mixed-version writer deployment.

For a frontend update requiring an in-app notice, ensure the reviewed version
changes the bytes of `frontend/public/service-worker.js`, including its `RELEASE`
value. A change only to other assets does not create a waiting worker. This is a
manual release requirement, not an automatic build stamp. Then:

```sh
wiki_compose config --quiet
wiki_compose pull backend mcp frontend
wiki_compose up -d --no-build --wait
wiki_compose ps
```

`up` recreates changed services while preserving mounted volumes. `restart`
alone does not apply changed images, environment or Compose configuration. A
reviewed Git commit pins application source, not every build input: Docker base
tags and apt repositories remain mutable. Record the resulting image IDs; an
older-source rebuild is not proof of the identical former image.

The standard file already selects registry images. To pin an accepted version,
set `WIKI_BACKEND_IMAGE`, `WIKI_MCP_IMAGE` (defaults to the backend selection) and
`WIKI_FRONTEND_IMAGE` to matching reviewed tags or immutable registry digests.
Main builds publish `latest` and `sha-<short-commit>`; PR validation does not
publish these tags. Before a controlled update, verify both artifacts exist.
For retained local image IDs, do not pull: use `wiki_compose up -d --no-build
--pull never --wait`. Never assume that `latest` has already reached the host.

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
Reload older open Chat tabs so they use the updated browser storage implementation.
First preserve composer drafts, finish pending replies, and save any unsaved
fallback conversation or deliberately delete its unsaved messages. Reloading or closing the tab does not preserve that fallback or an unsent
composer draft. Ordinary navigation to another wiki view and back in the same
open tab retains the draft, including browser Back/Forward; see the
[demo tour](demo-start.md#take-a-short-tour).
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
# An existing name is not proof of an independent recovery. Stop if it exists.
if docker volume inspect "$WIKI_RECOVERY_VOLUME" >/dev/null 2>&1; then
  echo "Choose a new recovery volume name" >&2
  exit 1
fi
docker image inspect "$WIKI_BACKEND_IMAGE" >/dev/null
docker volume create "$WIKI_RECOVERY_VOLUME"
docker run --rm --network none --pull never --entrypoint python \
  -v "$WIKI_RECOVERY_VOLUME:/recovery" \
  -v "$PWD/.demo/operator-backups:/backups:ro" \
  "$WIKI_BACKEND_IMAGE" -m second_brain.wiki.backup restore \
  --archive "/backups/$WIKI_ARCHIVE" --vault /recovery/restored
```

Restore refuses an existing `restored` destination. Do not remove an earlier
recovery to make this command pass; choose another new destination instead. To
inspect the recovered wiki through Compose, use the checked-in
`docker-compose.wiki.recovery.yml` with the base file. It selects the restored
subdirectory and external volume, disables paid chat and remote delivery, and
uses only the three explicitly selected local images. It inherits local HTTP
access, not the installation's public proxy. Create an ignored inspection env
file (for example `.env.inspect`) with these values:

```dotenv
WIKI_RECOVERY_VOLUME=the-new-volume-you-just-restored
WIKI_BACKEND_IMAGE=sha256:the-retained-backend-image-id
WIKI_MCP_IMAGE=sha256:the-retained-mcp-image-id
WIKI_FRONTEND_IMAGE=sha256:the-retained-frontend-image-id
SECOND_BRAIN_WIKI_API_KEY=choose-a-separate-long-random-inspection-secret
WIKI_FRONTEND_PORT=0
WIKI_MCP_PORT=0
```

Replace the placeholders with the actual full IDs recorded before the update.
Verify each exists with `docker image inspect`; the `:?` checks require values
but do not validate image provenance or prohibit a mutable tag. Use a unique
inspection project, and only these two Compose files (no public proxy override):

```sh
wiki_inspect() {
  docker compose -p secondbrain-recovery-inspect --env-file .env.inspect \
    -f docker-compose.yml -f docker-compose.wiki.recovery.yml "$@"
}
wiki_inspect config --quiet
wiki_inspect up -d --no-build --pull never --wait
wiki_inspect port frontend 80
wiki_inspect port mcp 3001
wiki_inspect ps
```

Use the returned loopback addresses to verify reads/history/receipts before a
deliberate cutover. This is a writable inspection copy; any deliberate edit or
retry must target it, never the original. Do not attach two different writer
deployments to the same vault. When inspection is complete, `wiki_inspect down`
removes its containers and network while retaining the external recovery volume.
Retain both the original volume and recovery until accepted. The dedicated env
file is private; never commit it or print resolved configuration with secrets.
The
[backup/restore guide](backup-restore.md) explains the create-only restore and
provider/remote boundaries. Never restore over the live source or silently discard
post-backup edits. An incompatible old image is not a safe rollback just because
it once ran.

## Evidence boundary

The [disposable stack acceptance](managed-stack-acceptance.md) builds source and
checks real container restart, shared REST/MCP writes, synthetic HTTPS/auth,
address recovery and the checked-in recovery overlay with retained image IDs,
stopped one-off backup, an independent external volume and dynamic loopback ports.
Inspect the actual run result before treating this newly wired path as passed.
Browser acceptance separately
checks worker transitions and draft/reply guards. Neither proves this operator's
proxy, private content, published image availability, production upgrade or
physical installation. Inspect the reviewed revision's actual CI records and
perform the deployment-specific checks before release signoff.

Compose behavior: [project names](https://docs.docker.com/compose/how-tos/project-name/),
[network aliases](https://docs.docker.com/reference/compose-file/services/#aliases),
[up](https://docs.docker.com/reference/cli/docker/compose/up/),
[restart](https://docs.docker.com/reference/cli/docker/compose/restart/) and
[run](https://docs.docker.com/reference/cli/docker/compose/run/).


## Disposable old/new image compatibility gate

`python3 scripts/run-wiki-update-acceptance.py --baseline-source PATH` builds a
clean checkout of the pinned baseline `dceee9fd63ccd36b5c6d5bd0ebd6cb11b5e25477`
and the current clean candidate checkout. The managed-stack workflow obtains
both sources and runs this as a separate bounded Docker job. It keeps distinct
actual local image IDs and one token-owned synthetic volume, then starts old,
new, old again and the candidate again. Every transition stops both writers;
REST/MCP reads, exact histories, replayed request receipts, rejected stale writes
and writes made after rollback must survive the next image selection. Ports are
rediscovered after each recreation. No registry image is published.

The result records the exact source pair, image IDs, completed phases and owned
resource cleanup. A green guardrail unit test is not a successful Docker run;
inspect this job's original `result.json` and logs. This is one concrete server
compatibility pair, not a guarantee that every former version can read a newer
store. Mutable Docker bases and package mirrors remain build inputs. This gate
records whether worker bytes differ but does not keep a browser across versions:
PWA activation/draft guards across a real release, proxy/auth, external indexes,
production migration and physical installation remain separate acceptance.

## Browser CI runtime

The managed browser workflow uses the official
`mcr.microsoft.com/playwright:v1.64.0-noble` image as non-root UID 1001, matching
the checked-in npm lock. It still runs `npm ci`, then refuses a version mismatch
or missing Chromium/WebKit executable before the existing acceptance phases.
The prebuilt system libraries avoid repeating an apt download that has consumed
the entire job limit on the hosted mirror. Update the image and version guard
alongside a deliberate Playwright lockfile change; do not silently skip missing
browser requirements. Image pull, Python/toolcache permissions and actual browser
launch still require a successful hosted run. All acceptance phases and evidence
limits remain in place. This is CI infrastructure, not a production deployment.
See the [official container CI example](https://playwright.dev/docs/ci#via-containers).
## Real PWA image-update rehearsal

The image-update CI job also runs the opt-in kept-browser check:

```sh
python3 scripts/run-wiki-update-acceptance.py --baseline-source .demo/update-baseline --pwa
```

This requires the locked frontend dependencies and Playwright Chromium in
addition to the local Docker prerequisites above. The pinned baseline and
candidate are built as actual different images; the candidate worker has a
deliberate checked-in release change. The check refuses identical served worker
bytes. It keeps one browser/context and a stable loopback gateway origin while
the selected frontend container changes. A dirty tab must retain its native
editor, draft and selection when a clean second tab activates the real waiting
worker. It then saves through the real API and deliberately reloads. History,
the saved start-page preference, Home/root navigation and empty CacheStorage
are checked; provider endpoints remain disabled.

The gateway forwards the real image responses; it does not substitute worker
scripts or lifecycle events. Its HTTP loopback origin is browser-trusted for
service workers, **not production HTTPS or physical installation evidence**.
The original server old/new/old/resume checks continue after the browser closes.
Without `--pwa`, the runner retains its server-only behavior. A passing local
same-app worker-file rehearsal is useful driver integration evidence and does
not replace this Docker image pair or the operator's deployment-specific test.
Inspect `pwa_baseline`, `pwa_forward`, `pwa_crossversion` and `pwa-browser.log`
alongside the selected image IDs, content/history receipts and cleanup result.



