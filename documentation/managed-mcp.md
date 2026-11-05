# Managed Wiki MCP over HTTP

The managed profile provides the same eleven revision-aware content/retrieval/status tools and
`wiki://guidance` resource over stdio or Streamable HTTP. HTTP uses `/mcp`,
stateless requests, and JSON responses. It does not invoke model providers,
remember/recall or the legacy editorial agent. Reads do not invoke remote Git;
factory-owned background delivery synchronizes a configured Git target
independently of read requests. See [recoverable delivery](managed-delivery.md).

This is the sole MCP application. The old combined server and ingestion tools
have been removed. The current factory preserves `MCP_API_KEY`
from ENV/dotenv as a fallback when no nonempty `SECOND_BRAIN_WIKI_API_KEY`
is selected. This legacy-key mode retains `X-API-Key`, case-insensitive Bearer
and `?api_key=…` authentication, in that precedence. A wrong higher-priority
credential is rejected rather than bypassed with a matching lower-priority one.
The legacy missing/non-JSON Accept workaround is retained in this mode.

An explicit new key continues to select Bearer-only authentication. The scheme
is case-insensitive; credential values remain exact. URL credentials are removed
from the shared ASGI query scope before response-time server access logging,
including rejected requests; clients and upstream proxies must still avoid
logging their own incoming credential URLs.

Neither mode publishes `/register`, `/token`, or OAuth discovery endpoints.
In particular the old registration behavior that returned the configured shared
secret is not reproduced. Existing direct key/header URLs do not need those
routes. Clients that relied on OAuth-like discovery must instead configure a
static authenticated MCP URL/header. This service is not an OAuth
authorization server.

## Explicit local startup

Use an isolated managed vault, never a vault simultaneously written by the
legacy system. No vault is selected and no server is created at import time.
With the locked backend environment installed using `poetry sync --no-interaction`,
run from `backend/`. `poetry run` selects that environment without requiring shell activation:

```sh
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/isolated-vault \
  poetry run python -m uvicorn second_brain.wiki.mcp:http_app_factory \
    --factory --host 127.0.0.1 --port 3001
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3001/mcp`. Requests must
use the protocol's normal JSON content type and Accept headers. `/mcp/` normally
redirects with HTTP 307 to `/mcp`, preserving the method and body. Legacy URL-key
requests instead route internally without a redirect, so query redaction does
not discard authentication or put the key into a Location header. This also
works under an ASGI root-path prefix. Prefer the canonical slash-free URL.
Stdio startup remains
`poetry run python -m second_brain.wiki.mcp` from `backend/` with the same
explicit vault variable.

HTTP POST bodies are capped at 1,100,000 actual bytes, including JSON overhead,
independently of Content-Length. Oversized requests return HTTP 413; malformed
JSON, invalid Unicode encoding and decoder-depth failures return HTTP 400 with
a generic JSON-RPC parse error. Host, Origin and credential checks run before body
reads. These transport failures do not call wiki tools or publish content.

`SECOND_BRAIN_WIKI_API_KEY` optionally configures the server-side Bearer secret,
the same variable used by the managed REST factory. Supply it through the
process's secret environment, never frontend code, browser storage, URLs, or
committed configuration. An unkeyed server is intended only for a trusted local
host, bound to loopback. Bearer credentials require TLS for remote access.

## Network boundary

DNS rebinding protection stays enabled. Default allowed Host values are
`localhost`, `127.0.0.1`, and `[::1]`, including numeric ports. Default allowed
Origin values are their `http://` origins, including numeric ports. MCP clients
without an Origin header are accepted; present Origins must be explicitly
allowed. Malformed authorities, userinfo, lookalike port suffixes, opaque `null`
Origins, and Origin paths are rejected. No wildcard CORS is enabled.

For a deliberately configured reverse proxy, use comma-separated allowlists:

- `SECOND_BRAIN_WIKI_MCP_ALLOWED_HOSTS`: exact incoming Host authorities, for
  example `wiki.example` or `internal:3001`.
- `SECOND_BRAIN_WIKI_MCP_ALLOWED_ORIGINS`: exact browser-facing Origins, for
  example `https://wiki.example`. An empty value denies every present Origin.

Host and Origin lists are independent: a proxy may forward an internal Host
while the browser sends its public Origin. `X-Forwarded-Host` and
`X-Forwarded-Proto` do not grant trust. Configure the proxy to send a known Host,
use TLS and a configured Bearer key, and avoid exposing the upstream directly.
Only a `:*` wildcard for numeric ports is supported; wildcard hosts are rejected.
Empty Host lists are rejected. Host failures return 421, Origin failures 403,
and missing/incorrect configured Bearer keys 401 without echoing the secret.
Responses use `Cache-Control: no-store`.

The preview Compose file starts managed HTTP MCP on loopback port 3001 beside
the browser/API service. An explicit `WIKI_MCP_PORT` takes precedence over an
existing `MCP_PORT`; with neither configured, the preview default stays 3001.
For a legacy endpoint on port 3000, preserve `MCP_PORT=3000` or explicitly set
`WIKI_MCP_PORT=3000` before the deliberate cutover. The container still listens
on 3001; the upstream proxy must use the published host port:

```sh
cp .env.example .env
# Edit the secret and allowlists before starting.
docker compose pull
docker compose up -d --wait
```

The MCP container receives the new key and the legacy `MCP_API_KEY` fallback;
the browser/API container deliberately receives neither MCP secret. Both mount the same managed vault, while only
the API process owns the polling delivery worker. The worker reconstructs
pending work written through either process. Container execution remains a
deployment check until it has been run in an environment with Docker.

For embedding without environment configuration, construct a `WikiStore` and
call `create_http_app(store, api_key, allowed_hosts=..., allowed_origins=...)`.
The returned Starlette app owns the real FastMCP session-manager lifespan; an
embedding parent must run that lifespan. Running managed REST and MCP with
stores pointing at the same isolated vault shares published revisions and
history; concurrent writers retain optimistic conflict checks.

## Editing contract and verification

Read `wiki://guidance`, then read a page and retain its revision. Save complete
Markdown with that `base_revision` and a unique `request_id`. Retry a lost reply
with the identical ID and payload. A revision conflict requires a fresh read
and deliberate reconciliation. Creating a page uses null `base_revision`.
Managed domain failures retain MCP's `isError: true`. Both `structuredContent`
and the text content contain the same JSON object with `error`, `message`, and
any domain details, such as `current_revision` on `revision_conflict`. A reused
request ID with a different payload returns `request_id_reused`; it must not be
retried as though publication were unknown. Missing-page reads use the same
domain-error result: `isError: true`
with `error: not_found`, a message, and the requested `id` in both JSON forms.
SDK validation and unexpected tool errors retain the SDK's error handling.
Publication succeeds independently from indexing; mutation receipts record pending
at publication and remote sync reports `not_configured`. `get_index_status` reads
current separate index receipts; `get_delivery_status` also reports cached Git
acknowledgements and worker progress. Factory-owned workers recover after saves
unless explicitly disabled. Optional semantic and `graph_rag` search plus bounded
`get_neighbors` use the shared services; see [managed indexes](managed-indexes.md).

Read compatibility: `search_wiki(query, limit, hpos)` accepts the legacy optional
arguments. With no explicit mode, configured vectors select semantic search
(default 15 hits); without vectors it uses lexical search (default 50). Explicit
`mode="lexical"` remains provider-independent and explicit semantic mode keeps
its default 10 hits. A supplied limit must be 1–50. `hpos` is 0–2 and expands each
semantic hit independently, preserving its neighbor association and snapshot
revision. Nonzero hpos with an incompatible explicit mode returns an error,
rather than silently ignoring it. Explicit `graph_rag` remains available; its
limit caps the combined results. `get_neighbors(id="page")` aliases `ids=["page"]`;
conflicting simultaneous inputs are refused. REST/chat retain their explicit
search modes and use the same underlying retrieval services.

`backend/tests/test_wiki_mcp_http.py` exercises the actual in-process FastMCP
HTTP application and lifespan: initialization, tool discovery, guidance, save,
retry, conflict, readback through MCP and REST, slash behavior, Bearer rejection,
Host/Origin defenses, and proxy allowlists. Tests require no running server or
external service and use only synthetic temporary vaults.

`backend/tests/test_wiki_mcp_stdio.py` additionally starts the actual stdio module
with an SDK client, isolated HOME/Git configuration and disabled external providers.
It checks guidance/discovery, an active local worker, REST/MCP shared publication,
structured conflict/reused-ID errors, and save/delete receipt replay across fresh
server processes without duplicate history. The SDK owns child shutdown even on
failure; the whole exchange has a bounded timeout. These are protocol and local
persistence checks, not a hosted client or production-credential acceptance.

