# Managed Wiki MCP over HTTP

The managed profile provides the same seven revision-aware WikiStore tools and
`wiki://guidance` resource over stdio or Streamable HTTP. HTTP uses `/mcp`,
stateless requests, and JSON responses. It does not invoke model providers,
remember/recall, remote Git, or the legacy editorial agent.

This is an independent, opt-in deployment. Existing legacy MCP production
routes, authentication, REST API, and configuration remain unchanged. Legacy
also uses `/mcp`, but its key inputs and OAuth-like registration endpoints are
not part of this profile. Managed HTTP accepts only `Authorization: Bearer …`
when a key is configured; it never accepts keys in a URL or `X-API-Key` and does
not publish `/register`, `/token`, or OAuth discovery endpoints. It is a static
Bearer deployment, not an OAuth authorization server.

## Explicit local startup

Use an isolated managed vault, never a vault simultaneously written by the
legacy system. No vault is selected and no server is created at import time.
With the backend environment installed, run from `backend/`:

```sh
SECOND_BRAIN_WIKI_VAULT=/absolute/path/to/isolated-vault \
  uvicorn second_brain.wiki.mcp:http_app_factory --factory --host 127.0.0.1 --port 3001
```

Connect a Streamable HTTP MCP client to `http://127.0.0.1:3001/mcp`. Requests must
use the protocol's normal JSON content type and Accept headers. `/mcp/` redirects
with HTTP 307 to `/mcp`, preserving the method and body; configure clients with
the canonical slash-free URL. Stdio startup remains
`python -m second_brain.wiki.mcp` with the same explicit vault variable.

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
Publication succeeds independently from indexing; mutation receipts record pending
at publication and remote sync reports `not_configured`. `get_index_status` reads
current separate receipts. Optional semantic and `graph_rag` search plus bounded
`get_neighbors` use the shared services; see [managed indexes](managed-indexes.md).

`backend/tests/test_wiki_mcp_http.py` exercises the actual in-process FastMCP
HTTP application and lifespan: initialization, tool discovery, guidance, save,
retry, conflict, readback through MCP and REST, slash behavior, Bearer rejection,
Host/Origin defenses, and proxy allowlists. Tests require no running server or
external service and use only synthetic temporary vaults.
