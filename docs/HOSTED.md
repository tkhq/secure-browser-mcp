# Hosted broker

The hosted broker serves the same MCP tools over Streamable HTTP, so an agent platform can connect by URL instead of starting the broker on the operator's machine. The entrypoint is `src/http.ts`. The stdio entrypoint (`src/index.ts`) does not change.

This is a Turnkey-operated fill service. The broker runs on our infrastructure and decrypts each secret before it sends the value to the browser. By default the browsers run on Browserbase, so secret plaintext exists in the broker process and in the Browserbase browser during a fill. Read the [hosted section of the threat model](THREAT-MODEL.md#hosted-broker) before you describe this service to a customer.

The broker serves one MCP endpoint per tenant, `/t/{tenant}/mcp`, and is an OAuth 2.1 resource server for each, as the MCP authorization spec describes. A tenant's agents present access tokens from the tenant's own authorization server. A tenant's sessions use the tenant's own Turnkey organization and API key, and its parked fills are encrypted under its own key.

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

Without an authorization server at hand, set `SBM_DEV_SHARED_TOKEN=1` and `SBM_HTTP_TOKEN`. The broker then also serves `/mcp` for any client that sends `Authorization: Bearer <SBM_HTTP_TOKEN>`, with every scope, using the `TURNKEY_*` key (or the mock backend). It logs a warning at startup. `SBM_HTTP_TOKEN` without the flag stops the broker from starting, so a step-1 deployment cannot keep running on the shared token by accident. Do not use this mode in production; the container image does not set the flag.

```sh
SBM_DEV_SHARED_TOKEN=1 SBM_HTTP_TOKEN="$(openssl rand -hex 32)" bun run serve
```

## Configuration

| Variable                    | Default           | Purpose                                                                                                                           |
| --------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `SBM_TENANTS`               | (none)            | Path to the tenant file. The image sets `/etc/sbm/tenants.json`; mount the file there.                                            |
| `SBM_PUBLIC_URL`            | (required)        | The origin clients reach the broker at, such as `https://sbm.example.com`. Token audiences are built from it.                     |
| `SBM_DEV_SHARED_TOKEN`      | (off)             | `1` serves `/mcp` with `SBM_HTTP_TOKEN`. Development only.                                                                        |
| `SBM_HTTP_TOKEN`            | (none)            | The shared token for `SBM_DEV_SHARED_TOKEN`.                                                                                      |
| `SBM_HTTP_HOST`             | `127.0.0.1`       | Listen address. The container image sets `0.0.0.0`.                                                                               |
| `SBM_HTTP_PORT`             | `8080`            | Listen port.                                                                                                                      |
| `SBM_STATE_DIR`             | (none)            | Directory for parked fills. Without it, a restart strands every pending approval.                                                 |
| `SBM_STATE_KEY`             | (none)            | 32-byte key, 64 hex characters or base64. Required with `SBM_STATE_DIR`. Each tenant's key is derived from it.                    |
| `SBM_BROWSER`               | `local`           | Where session browsers run: `local` (Chrome on this host) or `browserbase`. The image sets `browserbase`.                         |
| `BROWSERBASE_API_KEY`       | (none)            | Required with `SBM_BROWSER=browserbase`.                                                                                          |
| `BROWSERBASE_PROJECT_ID`    | (first project)   | Browserbase project for sessions.                                                                                                 |
| `SBM_BROWSERBASE_TIMEOUT_S` | (project default) | Maximum Browserbase session length, in seconds.                                                                                   |
| `SBM_MAX_SESSIONS`          | `8`               | Concurrent agent sessions. Each session gets its own browser. On Browserbase, keep this at or below the plan's concurrency limit. |
| `SBM_SESSION_IDLE_S`        | `1800`            | The broker closes a session, and its browser, after this many idle seconds.                                                       |
| `SBM_CHROME_ARGS`           | (none)            | Local Chrome only. Extra Chrome flags, separated by spaces.                                                                       |

`TURNKEY_API_BASE_URL` and the browser `SBM_*` variables work as in the stdio broker. The `TURNKEY_API_*` key and `TURNKEY_ORGANIZATION_ID` are used only by the development `/mcp` endpoint; tenants name their own.

`GET /healthz` returns `{"ok":true,"tenants":<count>}` without authentication.

## Tenants

`SBM_TENANTS` names a JSON file. It is deployment configuration: keep it out of this repository and out of the state volume. It holds references to keys, never keys.

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
    },
    {
      "id": "globex",
      "organizationId": "<Turnkey sub-organization id>",
      "apiKey": { "path": "/run/secrets/globex-turnkey.json" },
      "issuers": [
        {
          "issuer": "https://globex.okta.com/oauth2/default",
          "jwksUri": "https://globex.okta.com/oauth2/default/v1/keys"
        }
      ],
      "authorizationServers": ["https://globex.okta.com/oauth2/default"]
    }
  ]
}
```

| Field                  | Meaning                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | Lowercase letters, digits, and dashes. Appears in the endpoint URL and the state directory.                                                                                                                   |
| `organizationId`       | The tenant's Turnkey organization (usually a sub-organization). Every secret the tenant's sessions list or fill comes from here.                                                                              |
| `apiKey`               | The Turnkey API key the broker uses for this tenant: two environment variable names, or `path` to a JSON file `{"publicKey": "...", "privateKey": "..."}` in a secrets mount. The broker reads it at startup. |
| `issuers`              | The authorization servers whose tokens this tenant accepts: the exact `iss` value and the JWKS URI. HTTPS only (HTTP is accepted for `localhost`).                                                            |
| `authorizationServers` | Optional. What the Protected Resource Metadata advertises. Defaults to the `issuer` values.                                                                                                                   |
| `backend`              | Optional. `"turnkey"` (default) or `"mock"`. A mock tenant has in-memory secrets (`mockSecrets`, or the demo seed) and logs a warning. Development and tests only.                                            |

Give each tenant its own API key, scoped by Turnkey policy to its own organization: the broker keeps tenants apart by never using one tenant's key for another, and Turnkey policy is what stops a key from reaching further. Approvals stay in Turnkey policy, as with the stdio broker.

The broker reads the file once at startup. Restart it to add or change a tenant.

## Authorization

For a tenant `acme` behind `SBM_PUBLIC_URL=https://sbm.example.com`:

| What                                      | Value                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| MCP endpoint, and the resource (RFC 8707) | `https://sbm.example.com/t/acme/mcp`                                      |
| Protected Resource Metadata (RFC 9728)    | `https://sbm.example.com/.well-known/oauth-protected-resource/t/acme/mcp` |

The metadata document lists `resource`, `authorization_servers`, `scopes_supported`, and `bearer_methods_supported: ["header"]`. It needs no authentication.

**Tokens.** Each request carries `Authorization: Bearer <access token>`. The broker accepts a JWT access token (RFC 9068) only when:

- `iss` is exactly one of the tenant's `issuers`,
- the signature verifies against that issuer's JWKS with RS256, PS256, ES256, ES384, or EdDSA,
- `aud` is exactly the tenant's resource URI (a single audience; a token that also names other audiences is refused),
- `exp` is present and not past, and `nbf`, if present, is not in the future, each with 30 seconds of clock skew,
- `sub` is present.

The broker caches each JWKS for 10 minutes and fetches it again when a token names a key id it does not have (at most once every 30 seconds). If the JWKS cannot be fetched, the token is refused. The broker does not introspect opaque tokens and does not accept refresh tokens; the client refreshes with its authorization server. Tokens go nowhere but the validator: not to Turnkey, not to Browserbase, and not to the logs.

**Scopes.** Each tool needs one scope:

| Scope        | Tools                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `sbm:browse` | `navigate`, `snapshot`, `click`, `type_text`, `list_network_requests` |
| `sbm:fill`   | `fill_secret`, `await_fill`                                           |
| `sbm:refs`   | `list_secret_refs`                                                    |

Opening a session and listing tools needs only a valid token. An agent that fills secrets needs all three scopes. The broker checks scopes on every request against the token sent with it, so a client that steps up its token gets the new scopes in the same session.

**Errors.**

- No token, or an invalid one: `401` with `WWW-Authenticate: Bearer error="invalid_token", scope="sbm:browse sbm:fill sbm:refs", resource_metadata="<metadata URL>"` (no `error` when the request had no token). MCP clients follow `resource_metadata` to find the authorization server.
- A tool call without the tool's scope: `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="<the scope the tool needs>", resource_metadata="..."`.
- An unknown tenant: `404`.

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

## Sessions

- Each MCP session gets its own browser (a local Chrome process with a fresh profile, or a new Browserbase session), its own redaction registry, and its own element uids. One session cannot see another session's pages, cookies, or snapshots.
- A session belongs to the tenant and the token subject (`iss` and `sub`) that opened it. A request with that session id from another tenant's endpoint or another subject gets `404 Session not found`.
- Browserbase sessions start with recording and session logs off, and with `keepAlive: false`. The broker releases the Browserbase session when the MCP session closes.
- A session sees only the pending fills it parked. `await_fill` with a fill id that belongs to another live session, another subject, or another tenant returns `Unknown fill_id`.
- The broker closes a session's browser when the client sends `DELETE`, when the session is idle for `SBM_SESSION_IDLE_S`, and at shutdown.

## Restarts and pending fills

A parked fill holds the export's decryption key. With `SBM_STATE_DIR` set, the broker writes each parked fill to one AES-256-GCM file under `SBM_STATE_DIR/tenants/<tenant>/`, and loads the files at startup. Each tenant's files are encrypted with a key derived from `SBM_STATE_KEY` and the tenant id (HKDF-SHA256), so one tenant's file does not decrypt as another's. Parked fills from a step-1 broker (files directly in `SBM_STATE_DIR`) are not loaded.

After a restart, the old MCP session and its browser are gone. The client starts a new session (the broker answers the old session id with 404, as the MCP spec requires). A new session of the same tenant and subject can claim a parked fill by presenting its `fill_id`: the broker gave that random id only to the original session. The old element uids are gone too, so the agent navigates back to the page, takes a snapshot, and calls `await_fill` with the `fill_id` and the new `element_uid` or `fields`. The destination binding is checked again as for any fill.

If the page is not ready when the approval arrives, the broker drops the plaintext and keeps the fill. The agent can call `await_fill` again with new targets; the approved export is redeemed again.

Run one broker process per state directory. Two processes that share a directory do not see each other's writes.

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
