# Hosted broker

The hosted broker serves the same MCP tools over Streamable HTTP, so an agent platform can connect by URL instead of starting the broker on the operator's machine. The entrypoint is `src/http.ts`. The stdio entrypoint (`src/index.ts`) does not change.

This is a Turnkey-operated fill service. The broker runs on our infrastructure and decrypts each secret before it sends the value to the browser. By default the browsers run on Browserbase, so secret plaintext exists in the broker process and in the Browserbase browser during a fill. Read the [hosted section of the threat model](THREAT-MODEL.md#hosted-broker) before you describe this service to a customer.

The broker serves one MCP endpoint per tenant, `/t/{tenant}/mcp`, and is an OAuth 2.1 resource server for each, as MCP authorization describes. Each tenant has its own authorization server, Turnkey organization and API key, and key for parked fills.

## Run it locally

```sh
export SBM_TENANTS="$PWD/tenants.json"    # see "Tenants" below
export SBM_PUBLIC_URL="http://127.0.0.1:8080"
export SBM_STATE_DIR="$HOME/.sbm-state"
export SBM_STATE_KEY="$(openssl rand -hex 32)"
bun run serve     # http://127.0.0.1:8080/t/<tenant>/mcp, browsers run as local Chrome
```

To run the session browsers on Browserbase, as the hosted deployment does, also set `SBM_BROWSER=browserbase` and `BROWSERBASE_API_KEY`.

Keep `SBM_STATE_KEY` stable across restarts. A different key cannot read the parked fills, and the broker skips them.

### Development: one shared token

Without an authorization server, set `SBM_DEV_SHARED_TOKEN=1` and `SBM_HTTP_TOKEN`. The broker then also serves `/mcp` to any client that sends that bearer token, with every scope and the `TURNKEY_*` key (or the mock backend). `SBM_HTTP_TOKEN` without the flag stops the broker at startup. Do not use this in production. The image does not set the flag.

```sh
SBM_DEV_SHARED_TOKEN=1 SBM_HTTP_TOKEN="$(openssl rand -hex 32)" bun run serve
```

## Configuration

| Variable                         | Default           | Purpose                                                                                                                                                                                      |
| -------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SBM_TENANTS`                    | (none)            | Path to the tenant file. The image sets `/etc/sbm/tenants.json`; mount the file there.                                                                                                       |
| `SBM_PUBLIC_URL`                 | (required)        | The origin clients reach the broker at, such as `https://sbm.example.com`. Token audiences are built from it.                                                                                |
| `SBM_DEV_SHARED_TOKEN`           | (off)             | `1` serves `/mcp` with the shared token `SBM_HTTP_TOKEN`. Development only.                                                                                                                  |
| `SBM_HTTP_HOST`                  | `127.0.0.1`       | Listen address. The container image sets `0.0.0.0`.                                                                                                                                          |
| `SBM_HTTP_PORT`                  | `8080`            | Listen port.                                                                                                                                                                                 |
| `SBM_STATE_DIR`                  | (none)            | Directory for parked fills. Without it, a restart strands every pending approval.                                                                                                            |
| `SBM_STATE_KEY`                  | (none)            | 32-byte key, 64 hex characters or base64. Required with `SBM_STATE_DIR`. Each tenant's key is derived from it.                                                                               |
| `TURNKEY_SIGNER_PUBLIC_KEY`      | (SDK default)     | Enclave quorum key that signs secret bundles. Required when `TURNKEY_API_BASE_URL` points at a Turnkey environment with its own enclaves; production needs nothing. Applies to every tenant. |
| `SBM_BROWSER`                    | `local`           | Where session browsers run: `local` (Chrome on this host) or `browserbase`. The image sets `browserbase`.                                                                                    |
| `BROWSERBASE_API_KEY`            | (none)            | Required with `SBM_BROWSER=browserbase`.                                                                                                                                                     |
| `BROWSERBASE_PROJECT_ID`         | (first project)   | Browserbase project for sessions.                                                                                                                                                            |
| `SBM_BROWSERBASE_TIMEOUT_S`      | (project default) | Maximum Browserbase session length, in seconds.                                                                                                                                              |
| `SBM_MAX_SESSIONS`               | `8`               | Concurrent agent sessions. Each session gets its own browser. On Browserbase, keep this at or below the plan's concurrency limit.                                                            |
| `SBM_MAX_SESSIONS_PER_TENANT`    | (equal share)     | Concurrent sessions per tenant. The default is `SBM_MAX_SESSIONS` divided by the number of tenants (the dev `/mcp` endpoint counts as one).                                                  |
| `SBM_MAX_SESSIONS_PER_PRINCIPAL` | `4`               | Concurrent sessions per principal (`iss` and `sub`) in one tenant. The default is never more than the per-tenant limit. Does not apply to the dev `/mcp` endpoint.                           |
| `SBM_SESSION_IDLE_S`             | `1800`            | The broker closes a session, and its browser, after this many idle seconds.                                                                                                                  |
| `SBM_CHROME_ARGS`                | (none)            | Local Chrome only. Extra Chrome flags, separated by spaces.                                                                                                                                  |
| `SBM_ALLOWED_ORIGINS`            | (none)            | Browser origins that may call the MCP endpoints, separated by commas. Any other `Origin` header gets `403`. See [Origin check](#origin-check).                                               |

`TURNKEY_API_BASE_URL` and the browser `SBM_*` variables work as in the stdio broker. Only the dev `/mcp` endpoint uses `TURNKEY_API_*` and `TURNKEY_ORGANIZATION_ID`.

`GET /healthz` returns `{"ok":true,"tenants":<count>}` without authentication.

## Tenants

`SBM_TENANTS` names a JSON file of deployment configuration. Keep it out of this repository and out of the state volume. It holds references to keys, never keys.

```json
{
  "tenants": [
    {
      "id": "acme",
      "organizationId": "<Turnkey sub-organization id>",
      "apiKey": {
        "publicKeyEnv": "ACME_TURNKEY_API_PUBLIC_KEY",
        "privateKeyEnv": "ACME_TURNKEY_API_PRIVATE_KEY"
      },
      "issuers": [
        {
          "issuer": "https://login.acme.com",
          "jwksUri": "https://login.acme.com/.well-known/jwks.json"
        }
      ]
    }
  ]
}
```

| Field                  | Meaning                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                   | Lowercase letters, digits, and dashes. Used in the endpoint URL and the state directory.                                                                                                                                                                                                                           |
| `organizationId`       | The tenant's Turnkey organization. Every secret the tenant's sessions see comes from it.                                                                                                                                                                                                                           |
| `apiKey`               | The tenant's Turnkey API key: `publicKeyEnv` and `privateKeyEnv` (environment variable names), or `path` to a JSON file `{"publicKey": "...", "privateKey": "..."}`.                                                                                                                                               |
| `issuers`              | The authorization servers whose tokens the tenant accepts: the exact `issuer` and its `jwksUri`. HTTPS only (HTTP for `localhost`). `"requireTyp": true` also requires the `typ: at+jwt` header.                                                                                                                   |
| `audience`             | Optional. The exact `aud` of the tenant's tokens, when the server cannot use the resource URI (Entra ID's `api://<app id>`). The default is the resource URI. Two tenants cannot share an audience.                                                                                                                |
| `allowedClients`       | Optional. Client ids (`azp`, else `client_id`) whose tokens the tenant accepts. With it, a token must name its client. Without it, the tenant accepts every client its authorization servers issue tokens to, including dynamically registered clients and tokens that name no client (see [Sessions](#sessions)). |
| `authorizationServers` | Optional. What the Protected Resource Metadata advertises. The default is the `issuer` values.                                                                                                                                                                                                                     |
| `backend`              | Optional. `"turnkey"` (default) or `"mock"`: in-memory `mockSecrets`, for development and tests only.                                                                                                                                                                                                              |

Give each tenant its own API key, scoped by Turnkey policy to its own organization. The broker never uses one tenant's key for another; Turnkey policy stops a key from reaching further. Approvals stay in Turnkey policy.

The broker reads the file and resolves every API key at startup. One missing key stops the broker. Restart it to add a tenant or rotate a key.

### Set up the tenant's authorization server

The server must issue JWT access tokens whose `aud` is the tenant's resource URI (or `audience`) and nothing else. Many servers add other audiences by default, and the broker refuses a token with more than one.

**Keycloak.** Access tokens include the `account` audience by default. For the agent's client:

1. Add an **Audience** mapper to the client or one of its client scopes. Set **Included Custom Audience** to the resource URI, such as `https://sbm.example.com/t/acme/mcp`, and turn on **Add to access token**.
2. Remove the `account` audience: remove the `roles` client scope from the client, or its **audience resolve** mapper, or the `account` client roles from the realm's default roles. Otherwise `aud` is `["account", "<resource URI>"]`.
3. Add the client scopes `sbm:browse`, `sbm:fill`, and `sbm:refs`, and assign them to the client.
4. Decode a token. `aud` must be the resource URI alone.

The issuer is `https://<keycloak host>/realms/<realm>`. The JWKS URI is `https://<keycloak host>/realms/<realm>/protocol/openid-connect/certs`.

**Entra ID.** Entra ID cannot put the resource URI in `aud`: set the tenant's `audience` to the app's `api://<app id>`. Its access tokens have `typ: JWT`, so leave `requireTyp` off. Expose the `sbm:*` scopes as delegated scopes; they arrive in `scp`. The broker does not read app roles (`roles`).

## Authorization

For a tenant `acme` behind `SBM_PUBLIC_URL=https://sbm.example.com`:

| What                                      | Value                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| MCP endpoint, and the resource (RFC 8707) | `https://sbm.example.com/t/acme/mcp`                                      |
| Protected Resource Metadata (RFC 9728)    | `https://sbm.example.com/.well-known/oauth-protected-resource/t/acme/mcp` |

The metadata needs no authentication.

**Tokens.** Each request carries `Authorization: Bearer <access token>`. The broker accepts a signed JWT access token only when:

- `iss` is exactly one of the tenant's `issuers`,
- the signature verifies against that issuer's JWKS with RS256, PS256, ES256, ES384, or EdDSA,
- `aud` is exactly the tenant's resource URI (or `audience`), with no other audience,
- the header has `typ: at+jwt`, if the issuer has `requireTyp`,
- `exp` is present and not past, and `nbf`, if present, is not in the future, with 30 seconds of clock skew,
- `exp` is at most 24 hours after now, and at most 24 hours after `iat` if present,
- there is no `nonce` or `at_hash` claim (these mark an OpenID Connect ID token),
- `sub` is present,
- the token names a client (`azp`, else `client_id`) that is in `allowedClients`, if the tenant has that list.

Scopes come from `scope` (space-separated) and `scp` (a string or an array, as Okta issues), merged. A client-credentials token works if it meets the same rules; its `sub` is usually the client id. The broker does not accept opaque tokens or refresh tokens.

The broker caches each JWKS for 10 minutes and refetches it, at most every 30 seconds, for an unknown key id. If the JWKS cannot be fetched, the token is refused. Tokens are not sent to Turnkey or Browserbase and are not logged.

**Scopes.** Each tool needs one scope:

| Scope        | Tools                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `sbm:browse` | `navigate`, `snapshot`, `click`, `type_text`, `list_network_requests` |
| `sbm:fill`   | `fill_secret`, `await_fill`                                           |
| `sbm:refs`   | `list_secret_refs`                                                    |

Opening a session needs at least one of these scopes; without one, the broker answers `403 insufficient_scope` with `scope="sbm:browse"`. Listing tools needs nothing more. An agent that fills secrets needs all three. The broker checks scopes on every request against that request's token, so a client that steps up its token gets the new scopes in the same session.

**Errors.**

- No token, or an invalid one: `401` with `WWW-Authenticate: Bearer error="invalid_token", scope="sbm:browse sbm:fill sbm:refs", resource_metadata="<metadata URL>"`. There is no `error` when the request has no `Bearer` credentials. MCP clients follow `resource_metadata` to the authorization server.
- A malformed `Bearer` header: `400` with `error="invalid_request"`.
- A tool call without its scope: `403` with `error="insufficient_scope"` and the missing scopes. A batch names every missing scope in one challenge.
- A JSON-RPC id already in flight in the session, or one id twice in a batch: `409` with JSON-RPC error `-32600`.
- An unknown tenant: `404`.
- The broker, the tenant, or the principal at its session limit: `503`.

## Connect Hermes

Point Hermes at the tenant's endpoint:

```yaml
mcp_servers:
  secure-browser:
    url: "https://<broker-host>/t/<tenant>/mcp"
```

A client that implements MCP authorization discovers the authorization server from the `401` and signs in. A client that only sends static headers needs an access token obtained elsewhere, in `headers: { Authorization: "Bearer <token>" }`, and must replace it before it expires.

Check the connection with `hermes mcp test secure-browser`. It must list the same tools as the stdio broker. Install the skill as usual (`bun run skill:install -- --hermes`); the skill does not change.

The hosted browser runs on the broker host. `localhost` in a URL refers to that host, not to the agent's machine, so the local demo fixture works only when the fixture runs beside the broker.

## Origin check

The MCP Streamable HTTP spec requires the server to check the `Origin` header. This stops a web page in a user's browser from calling the broker, for example through DNS rebinding. The check applies to every MCP endpoint.

- A request without an `Origin` header passes. Non-browser MCP clients (Hermes, Claude Code, the SDK clients) do not send one.
- A request with an `Origin` header passes only if the value is in `SBM_ALLOWED_ORIGINS`. The match is exact: scheme, host, and port. The browser's opaque origin `null` never matches.
- The default is empty, so the broker refuses every request that has an `Origin` header.
- A refused request gets `403` with the JSON-RPC error `Origin not allowed`. The broker sends this before it checks the bearer token and before it opens or finds a session.

Each entry must be a bare origin (`scheme://host[:port]`, no path). The broker does not start if an entry is not an origin.

An allowed origin does not replace the bearer token. The broker does not send CORS headers on the MCP endpoints yet, so a browser page on an allowed origin still cannot read responses.

The Protected Resource Metadata is not checked. It is public, and browser-based clients read it from other origins, so the broker serves it with `Access-Control-Allow-Origin: *`.

## Protocol versions

The broker serves the 2025 session protocol, up to MCP revision `2025-11-25`: the client sends `initialize` and then sends the `Mcp-Session-Id` header on each request. This is the default for current MCP clients.

The broker does not serve revision `2026-07-28` yet. That revision has no sessions, and the broker keeps one browser per session. A 2026-07-28 request (for example `server/discover`, with the protocol version in the request's `_meta`) gets HTTP `400` with the JSON-RPC error `-32022` (unsupported protocol version):

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32022,
    "message": "Unsupported protocol version: 2026-07-28. This broker serves the 2025-era session protocol only; connect with initialize (protocol version 2025-11-25).",
    "data": {
      "supported": [
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
        "2024-10-07"
      ],
      "requested": "2026-07-28"
    }
  },
  "id": 7
}
```

A client that negotiates the version (MCP TypeScript SDK v2 `versionNegotiation: { mode: "auto" }`) reads this error and connects with `initialize`. A client that requires 2026-07-28 fails to connect with this error.

## Sessions

- Each MCP session gets its own browser (a local Chrome process with a fresh profile, or a new Browserbase session), its own redaction registry, and its own element uids. One session cannot see another session's pages, cookies, or snapshots.
- A session belongs to the tenant, subject (`iss` and `sub`), and OAuth client (`azp`, else `client_id`) that opened it. Anyone else gets `404 Session not found`.
- If the token that opened a session has no `azp` or `client_id`, the broker cannot tell clients apart. The session then belongs to the tenant and subject only: any token of that subject without a client claim can use it, and a token with a client claim cannot. To bind every session to a client, set `allowedClients`. The broker then refuses tokens without a client claim.
- Browserbase sessions start with recording and session logs off, and with `keepAlive: false`. The broker releases the Browserbase session when the MCP session closes.
- A `GET` stream (server-to-client events) outlives its request, so the broker ends it when the token that opened it expires. The client reopens it with a fresh token.
- Two requests in flight in one session cannot share a JSON-RPC id. The second would get the first one's response, even without the first one's scope. The broker answers `409`. An id is free again when the server has answered it and its HTTP response has ended.
- A session sees only the pending fills it parked. `await_fill` with a fill id that belongs to another live session, another subject, or another tenant returns `Unknown fill_id`.
- The broker closes a session's browser when the client sends `DELETE`, when the session is idle for `SBM_SESSION_IDLE_S`, and at shutdown.

## Restarts and pending fills

A parked fill holds the export's decryption key. With `SBM_STATE_DIR` set, the broker writes each parked fill to one AES-256-GCM file under `SBM_STATE_DIR/tenants/<tenant>/`, encrypted with a key derived from `SBM_STATE_KEY` and the tenant id (HKDF-SHA256), and loads the files at startup.

After a restart, the old MCP session and its browser are gone. The client starts a new session (the broker answers the old session id with 404, as the MCP spec requires). A new session of the same tenant and subject can claim a parked fill by presenting its `fill_id`: the broker gave that random id only to the original session. The old element uids are gone too, so the agent navigates back to the page, takes a snapshot, and calls `await_fill` with the `fill_id` and the new `element_uid` or `fields`. The destination binding is checked again as for any fill.

If the page is not ready when the approval arrives, the broker drops the plaintext and keeps the fill. The agent can call `await_fill` again with new targets; the approved export is redeemed again.

Run one broker process per state directory. Two processes that share a directory do not see each other's writes.

### Upgrading from the shared token

A shared-token broker parked fills directly in `SBM_STATE_DIR`, owned by no tenant. This broker does not load them, and logs how many it skipped. Before the upgrade, let the agents redeem their parked fills, or wait for the 24-hour expiry. A fill still waiting at the upgrade is lost, and its approval must be requested again. Then delete the `*.fill` files left directly in `SBM_STATE_DIR`.

## Container

```sh
docker build -t secure-browser-mcp .
docker run --rm -p 8080:8080 \
  -e SBM_PUBLIC_URL=https://sbm.example.com \
  -e SBM_STATE_KEY -e BROWSERBASE_API_KEY \
  -e ACME_TURNKEY_API_PUBLIC_KEY -e ACME_TURNKEY_API_PRIVATE_KEY \
  -v "$PWD/tenants.json:/etc/sbm/tenants.json:ro" \
  -v sbm-state:/var/lib/sbm \
  secure-browser-mcp
```

The default image has no Chrome. It runs session browsers on Browserbase, so it needs no seccomp changes, no extra memory for browsers, and no access to internal networks.

CI (`.github/workflows/build.yml`) builds this image on every pull request and, on each push to `main`, pushes it to Turnkey's internal registry tagged `main-<commit sha>`. The deployment manifests pin one of those tags.

### Local Chrome in a container

Build with `--build-arg LOCAL_CHROME=true` and run with `-e SBM_BROWSER=local` to keep browsers in the container. The image runs Chromium with its sandbox on, as a non-root user. The Chrome sandbox needs unprivileged user namespaces:

- Docker's default seccomp profile blocks them, and Chrome then fails to start (`Target closed`). Use a seccomp profile that permits `clone`, `unshare`, and `setns` for user namespaces. For a local check only, `--security-opt seccomp=unconfined` works.
- Hosts that set `user.max_user_namespaces = 0` (Talos does by default) cannot run the sandbox at all.

Do not add `--no-sandbox` to `SBM_CHROME_ARGS`: without the sandbox, a compromised renderer can read the broker's memory, which holds plaintext during a fill.

## Deployment requirements

- Terminate TLS in front of the broker, at the origin in `SBM_PUBLIC_URL`. Access tokens and tool results travel in the requests and responses.
- Restrict the broker's egress to the Turnkey API, Browserbase, and the tenants' JWKS URIs. With local Chrome, the browser can reach every address the container can reach, because the agent controls where it navigates: then restrict egress to the public internet, and block cloud metadata endpoints and internal services.
- Store `SBM_STATE_KEY` and the tenants' Turnkey API keys in the platform's secret store. Do not put them in the state volume or the tenant file.
- Run one replica per state volume.
