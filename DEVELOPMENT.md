# Developing SecondBrain

This guide covers the repository layout, architecture, local setup, tests, CI and
release workflow. For installing and running an instance, start with the
[README](README.md).

## Repository layout

```text
backend/          Python 3.12 service: REST API, MCP server, wiki store,
                  search, delivery worker, import/export and backup CLIs
frontend/         Vite + TypeScript web app, nginx config, service worker,
                  PWA assets and Playwright tests
documentation/    operator guides, architecture notes and evidence
scripts/          demo, import, browser and stack acceptance runners
examples/         synthetic demo and review vaults, plus a disposable TLS/auth
                  proxy fixture
docker-compose.yml                  image-only standard installation
docker-compose.source.yml           source-build overlay for local images
docker-compose.indexes.yml          optional Neo4j and Qdrant services
docker-compose.wiki.recovery.yml    isolated recovery inspection overlay
Makefile                            demo, check and acceptance targets
check.sh                            lint, type, test and build wrapper
```

## Architecture overview

### One content authority

The authoritative wiki is a bare Git repository, `.wiki.git`, inside the managed
vault. `refs/heads/wiki` points at the published snapshot. Trees contain
`pages/<id>.md`, per-page revision tokens and durable request receipts. The
working directory is not a second source of truth.

A save supplies the page's `base_revision`, the Markdown and a stable
`request_id`. Publication uses a compare-and-swap `git update-ref`; a stale base
fails instead of overwriting a newer edit. A lost acknowledgement is retried
with the identical request ID and payload. Earlier published versions remain in
Git history. This is implemented in `backend/src/second_brain/wiki/store.py`.

### Services

The standard Compose stack has three services:

- `frontend`: the Vite build served by nginx. It proxies same-origin `/api/` to
  the backend and keeps the public Host header intact for write-origin checks.
- `backend`: the managed REST API (`second_brain.wiki.api:app_factory`), backed
  by a named `managed_wiki` volume. It owns the background Git/index delivery
  worker.
- `mcp`: the Streamable HTTP MCP application
  (`second_brain.wiki.mcp:http_app_factory`) from the same backend image. It
  reads and writes the same store; the Compose service disables its background
  worker so only REST runs automatic delivery.

MCP is also available over stdio for local use:

```sh
cd backend
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/vault \
  poetry run python -m second_brain.wiki.mcp
```

The REST and MCP processes expose the same revisioned content service. REST
routes live under `/api/wiki`; MCP exposes 11 page/search/graph/group/history/
status tools plus the `wiki://guidance` resource. See
[managed MCP](documentation/managed-mcp.md).

### Retrieval, chat and delivery

- Lexical search, page reads, history and the Markdown link graph come directly
  from the published Git snapshot. They need no external service.
- Optional Neo4j and Qdrant adapters build immutable derived generations for
  graph retrieval and vector search. Readiness is published as a receipt for an
  exact content revision; a pending, failed or stale generation is never served
  as current. See [managed indexes](documentation/managed-indexes.md).
- Read-only chat uses the configured OpenRouter model with a bounded tool set:
  search, exact page reads and graph neighbors. It cannot save, delete or call
  arbitrary MCP tools. Conversations are stored in the browser, not the wiki.
- The delivery worker wakes after writes, on startup and periodically. It
  reconstructs pending Git/index work from content heads and durable receipts.
  A per-vault lock prevents competing pushes when multiple processes run. See
  [recoverable delivery](documentation/managed-delivery.md).

### Browser app

The frontend is plain TypeScript built with Vite. Main routes are `/`,
`/wiki/:id`, `/search`, `/galaxy`, `/chat` and `/resolve`. The service worker is
intentionally online-only: no fetch handler and no CacheStorage, so private
pages, chat and authorization responses are not cached. nginx serves the worker
with revalidation so a changed release can surface the in-app **Update now**
flow.

## Local development

Use Linux or WSL. Native Windows execution is not supported.

Prerequisites:

- Python 3.12
- Poetry 2.1.3
- Node 20+
- Git and Make
- For browser tests: Playwright Chromium and its Linux dependencies
- For stack acceptance: Docker Engine with Compose v2

Install the locked dependencies from the repository root:

```sh
(cd backend && poetry sync --no-interaction)
(cd frontend && npm ci)
```

### Fictional demo

The demo starts the real REST API and Vite app with an isolated fictional vault.
It retains later edits and does not need a model key, remote Git or
Neo4j/Qdrant.

```sh
WIKI_PYTHON="$(cd backend && poetry env info --executable)"
SECOND_BRAIN_WIKI_API_KEY= make demo PYTHON="$WIKI_PYTHON"
```

Open <http://127.0.0.1:5173>. The vault lives in `.demo/vault`; Ctrl+C stops both
services. The launcher clears inherited OpenRouter access. Use
`--with-openrouter` only for an explicit paid-provider run. See the
[demo guide](documentation/demo-start.md).

### Native development services

For a dedicated development vault, copy the environment template and select the
vault explicitly:

```sh
cp .env.example .env
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/dev-vault make dev
```

`make dev` runs the `Procfile`: REST on `127.0.0.1:8000`, MCP on
`127.0.0.1:3001`, and Vite on `127.0.0.1:5173`. The MCP entry disables
background delivery. `make dev-backend` starts only REST and MCP. Use
`API_PORT` and `MCP_PORT` to avoid another installation; Vite reads `API_PORT`
for its `/api` proxy.

Do not stop or reconfigure an existing installation to free ports. For an
empty, template or Git-imported vault outside the demo, use
[first-start profiles](documentation/first-start.md).

### Build the same app in Docker

The source overlay builds local `:dev` images from the same Compose definition:

```sh
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.source.yml up -d --build --wait
```

Do not copy `docker-compose.source.yml` into an image-only installation. The
standard installation, update and recovery path is documented in
[install/update](documentation/install-update.md).

## Checks and tests

### Fast checks

```sh
make check
```

This runs backend `ruff`, strict `mypy`, `pytest` excluding
`tests/integration`, frontend `typecheck` and the production build. The wrapper
version is also available:

```sh
./check.sh            # lint, types, full pytest, TypeScript check and build
./check.sh --no-tests # skip pytest
```

Individual backend commands:

```sh
cd backend
poetry run ruff check src/ tests/
poetry run mypy src/ tests/
poetry run pytest tests/ --ignore=tests/integration -q
```

Individual frontend checks:

```sh
cd frontend
npm run typecheck
npm run build
npm run test:pwa
npm run test:proxy
npm run test:dev-security
node --test tests/image-update-protocol.test.mjs
```

### Browser tests

Install Chromium once, start the isolated demo in another terminal, then run:

```sh
cd frontend
npx playwright install --with-deps chromium
npm run test:browser
```

The suite deliberately creates, edits and deletes fixture pages, so use only a
disposable synthetic vault. Run `make acceptance` instead if you want the runner
to start and stop the real API and Vite services for you.

The optional scale profile uses a generated 320-page, 648-link vault:

```sh
SECOND_BRAIN_WIKI_API_KEY= make demo-scale PYTHON="$WIKI_PYTHON"
cd frontend && PLAYWRIGHT_SCALE=1 npm run test:browser -- e2e/scale.spec.ts
```

### Acceptance targets

| Target | Scope |
| --- | --- |
| `make acceptance` | Fresh real API + Vite + normal Playwright suite |
| `make acceptance-first-start` | Empty wiki, first pages, then a real API/Vite restart on the same vault |
| `make acceptance-import` | Local Git import, retry and browser edit persistence |
| `make acceptance-scale` | Scale browser acceptance profile |
| `make acceptance-openrouter` | Explicit paid-provider gate; needs a provider key and sends only the public fictional fixture |
| `make acceptance-stack` | Isolated Compose build/start/restart/restore; requires local Docker |

The stack runner also exercises the image-only installation, HTTPS/auth
boundaries, REST/MCP sharing and backup/recovery. See
[stack acceptance](documentation/managed-stack-acceptance.md),
[index acceptance](documentation/managed-index-acceptance.md) and
[SSH acceptance](documentation/managed-ssh-acceptance.md).

## CI

Six GitHub Actions workflows:

| Workflow | Runs on | Main checks |
| --- | --- | --- |
| **Backend** | Push and PR to `main`/`develop` | Ruff, strict mypy, pytest; builds and publishes the backend image on branch pushes |
| **Frontend** | Push and PR to `main`/`develop` | Typecheck, Node tests, production build; builds and publishes the frontend image on branch pushes |
| **Managed wiki browser acceptance** | PR to `main`/`develop`, manual | Real API/Vite, Chromium and WebKit browser suites, PWA/update behavior, first start, import and scale |
| **Managed index acceptance** | PR to `main`/`develop`, manual | Real Neo4j and Qdrant containers with synthetic content and vectors |
| **Managed SSH Git acceptance** | PR to `main`/`develop`, manual | Real loopback OpenSSH agent-authenticated Git push/pull and host trust |
| **Managed stack acceptance** | PR to `main`/`develop`, manual | Image-only Compose install, HTTPS/auth stack, recovery and old/new image compatibility |

Pull requests validate builds but do not publish registry images. Pushes to
`main` publish `latest`; pushes to `develop` publish `next`. Every publication
also keeps a `sha-<short-commit>` tag. The backend and frontend images publish
independently, so wait for both matching builds before pulling a channel.
Obsolete PR runs are cancelled; branch publication runs are not.

Inspect the actual CI result for the reviewed commit. A local runner or a green
unit test is not evidence that a Docker, provider or browser gate passed.

## Release channels and branches

- `main` is the accepted application and publishes the stable `latest` images.
- `develop` is the next version under evaluation and publishes `next` images.
- Work in feature branches and merge into `develop` with explicit approval.
- After acceptance, open a release pull request from `develop` to `main`. Use a
  merge commit rather than rewriting history.
- Hotfixes applied to `main` should also be merged into `develop` before the
  next release.
- Use the Compose file and environment template from the branch that matches the
  selected channel. The stable and next installations can have different
  service layouts; do not mix images and Compose layouts as a rollback.

The full channel and image-tag rules are in
[release channels](documentation/release-channels.md).

## Detailed documentation

- [Current wiki development](documentation/managed-wiki-development.md)
- [Install, update and recover](documentation/install-update.md)
- [First start and setup profiles](documentation/first-start.md)
- [Fictional demo](documentation/demo-start.md)
- [Git delivery and conflicts](documentation/managed-delivery.md)
- [Explicit Git snapshot sync](documentation/managed-git-sync.md)
- [Indexes and semantic retrieval](documentation/managed-indexes.md)
- [Managed MCP over HTTP and stdio](documentation/managed-mcp.md)
- [Backup and restore](documentation/backup-restore.md)
- [Markdown import](documentation/wiki-import.md) and
  [Markdown export](documentation/wiki-export.md)
- [PWA installation, privacy and updates](documentation/pwa.md)
- [Stack acceptance](documentation/managed-stack-acceptance.md),
  [index acceptance](documentation/managed-index-acceptance.md) and
  [SSH acceptance](documentation/managed-ssh-acceptance.md)
- [Review handoff](documentation/review-handoff.md) and
  [guided 2.0 review](documentation/review-20-walkthrough.md)
- [Deferred feature wishes](documentation/feature-wishlist.md)