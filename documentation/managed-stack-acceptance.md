# Disposable managed Docker stack acceptance

From the repository root, with Python 3, Docker Engine and Docker Compose v2
available, run:

```sh
make acceptance-stack
```

The runner builds the checked-in backend and frontend Dockerfiles and starts
the managed REST API, HTTP MCP service and built frontend served by nginx. It
uses a generated Compose project with a new disposable named volume and
loopback-only endpoints. The vault is explicitly seeded with the fictional
Lantern Bay fixture; startup does not seed an existing wiki. The runner does
not use the legacy stack, production environment files or production volumes,
and does not publish container images.

Inherited OpenRouter credentials, optional index providers and outbound Git
delivery settings are disabled for this rehearsal. It makes no OpenRouter
calls and needs no external service credentials. Run it only with the included
synthetic fixture: service logs are retained as acceptance evidence.

## Evidence and CI

The runner returns a nonzero exit status when a required gate fails. Each run
writes a structural `result.json` and diagnostic logs beneath
`.demo/stack-acceptance/`. The result records the checked revision and gate
outcomes without page content or credentials. Containers and the disposable
volume are cleaned up at the end of the run; evidence remains for inspection.

The [managed stack workflow](../.github/workflows/managed-stack.yml) runs for
pull requests targeting `main` and can also be started with `workflow_dispatch`.
It runs on Ubuntu with Docker, has read-only repository permission and a
20-minute job limit. On success or failure it uploads only structural results
and logs, retained for seven days. Generated Compose configuration, environment
files and vault contents are excluded from the artifact.

Adding this workflow is not proof that the stack passed. Inspect the actual CI
run for the revision being reviewed and its `result.json`; a missing,
cancelled or failed run supplies no passing acceptance evidence.

## Scope of the gate

This is a real Docker build and container-runtime gate for the managed profile,
including the nginx frontend/API boundary and the shared REST/MCP vault. It
complements the local API/Vite browser rehearsal in
[demo-start.md](demo-start.md), whose success alone does not establish that the
Docker images or nginx profile work.

| Boundary | Required checks |
| --- | --- |
| Images and nginx | Build/start the real images; API health through nginx, SPA routes, manifest and service-worker update headers |
| Managed REST | Explicit template seed/retry, private-response cache headers, revisioned save/retry and stale-write conflict |
| HTTP MCP | Bearer denial, initialize, exact tool inventory, guidance resource and a write visible through REST |
| Shared vault | Graph links, history, backend/MCP restart persistence and the original write receipt |
| Recovery | Backup through the image CLI, restore into an independent new volume, matching page/history/receipt and refusal to reseed changed content |

The nginx checks are HTTP assertions against the built frontend. This runner
does not launch a browser; keep the separate Playwright acceptance rehearsal
for interactive editor and navigation behavior.

A passing synthetic stack run still does not establish hosted model or index
provider behavior, production Git authentication and delivery, production HTTPS
and reverse-proxy/authentication configuration, or installation and updates on
physical Android/iOS devices. Use the separate explicit OpenRouter acceptance
path for real model calls and the [PWA guide](pwa.md) for device checks. Production
deployment and private-vault acceptance remain separate work.
