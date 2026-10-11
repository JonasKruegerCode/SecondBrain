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

An additional disposable nginx fixture terminates TLS and applies Basic
authentication to the wiki, assets and API. Its certificate is generated on
each start, trusted explicitly by the test client, and checked for its loopback
hostname. The Python client's certificate verification is never disabled. The fixture's public
`fixture` / `fixture-password` credentials are synthetic and must never be used
for a real instance. The proxy preserves the public Host including the dynamic
port so same-origin writes traverse both proxy layers correctly.

The `/mcp` fixture route uses its existing Bearer gate, with Basic authentication
disabled for that route: both mechanisms use the same Authorization header.
The generated MCP configuration explicitly allows the synthetic HTTPS Origin.
This is a sample acceptance topology, not a change to the managed Compose
deployment or existing production authentication. Direct frontend/MCP ports
remain loopback-only for the separate HTTP checks; this fixture does not prove
that a production host has no authentication bypass.

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

After the image build, a short-lived owned network lets Docker choose a free
subnet immediately before the disposable Compose network is created. Probe
creation is tracked before invoking Docker, including ambiguous timeout
outcomes. Cleanup checks both the project and a per-run ownership label, refuses
foreign or attached networks, and removes an owned probe by ID. Failed cleanup
remains tracked for retry and cannot replace the original acceptance failure.

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
| Synthetic HTTPS/auth | Verified disposable certificate; anonymous/wrong-password denial for wiki, API and PWA resources; authenticated reads, writes/retry/conflict and foreign-Origin refusal; TLS MCP Bearer/Host/Origin gates and shared writes |
| Managed REST | Explicit template seed/retry, private-response cache headers, revisioned save/retry and stale-write conflict |
| HTTP MCP | Bearer denial, initialize, exact tool inventory, guidance resource and a write visible through REST |
| Shared vault | Graph links, history, backend/MCP restart persistence and the original write receipt |
| Proxy recovery | Force a different backend address on the owned disposable network; require recovery without restarting nginx, preserved escaped paths/query parameters, revision conflicts and write retries |
| Recovery | Backup through the image CLI, restore into an independent new volume, matching page/history/receipt and refusal to reseed changed content |

The default local runner uses HTTP/TLS assertions against the built frontend.
Keep the separate Playwright acceptance rehearsal for the full editor/navigation
suite. TLS resource/header delivery
does not prove browser service-worker registration or installation behind auth.
The result distinguishes `synthetic_https_auth` from `production_https: false`.

Compose service names remain stable while their IP addresses can change across
restarts. The built frontend and disposable TLS fixture use Docker's embedded
DNS resolver with a five-second cache, rather than keeping an address resolved
at nginx startup. The proxy target has no URI suffix, preserving the original
API path and query. See [Docker networking](https://docs.docker.com/compose/how-tos/networking/)
and [nginx proxy_pass](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).
The address-change gate validates this recovery boundary; it cannot by itself
establish the cause of an earlier intermittent restart failure.

CI additionally launches Chromium against the built, authenticated HTTPS
frontend. It checks Home at desktop/narrow widths, a real editor save/reload,
browser manifest parsing, secure-context worker registration and empty private
caches. It records six structural browser gates and two fictional screenshots.
The browser trusts only the disposable certificate's SPKI; the Python HTTP client
separately verifies the certificate and hostname. This is browser emulation,
not a production CA configuration or physical installation. To include it locally,
prepare frontend dependencies and Chromium (`npm ci` and `npx playwright install
--with-deps chromium` in `frontend`), then run
`SECOND_BRAIN_STACK_BROWSER=1 make acceptance-stack`.

A passing synthetic stack run still does not establish hosted model or index
provider behavior, production Git authentication and delivery, production HTTPS
and reverse-proxy/authentication configuration, or installation and updates on
physical Android/iOS devices. Use the separate explicit OpenRouter acceptance
path for real model calls and the [PWA guide](pwa.md) for device checks. Production
deployment and private-vault acceptance remain separate work.
