# Hosted broker

The hosted broker serves the same MCP tools over Streamable HTTP, so an agent platform can connect by URL instead of starting the broker on the operator's machine. The entrypoint is `src/http.ts`. The stdio entrypoint (`src/index.ts`) does not change.

This is a Turnkey-operated fill service. The broker and its browsers run on our infrastructure, and secret plaintext exists in the broker process during a fill. Read the [hosted section of the threat model](THREAT-MODEL.md#hosted-broker) before you describe this service to a customer.

## Run it locally

```sh
export SBM_HTTP_TOKEN="$(openssl rand -hex 32)"
export SBM_STATE_DIR="$HOME/.sbm-state"
export SBM_STATE_KEY="$(openssl rand -hex 32)"
bun run serve     # http://127.0.0.1:8080/mcp
```

Keep `SBM_STATE_KEY` stable across restarts. A different key cannot read the parked fills, and the broker skips them.

## Configuration

| Variable             | Default     | Purpose                                                                               |
| -------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `SBM_HTTP_TOKEN`     | (required)  | Clients send `Authorization: Bearer <token>`. The broker refuses to start without it. |
| `SBM_HTTP_HOST`      | `127.0.0.1` | Listen address. The container image sets `0.0.0.0`.                                   |
| `SBM_HTTP_PORT`      | `8080`      | Listen port.                                                                          |
| `SBM_STATE_DIR`      | (none)      | Directory for parked fills. Without it, a restart strands every pending approval.     |
| `SBM_STATE_KEY`      | (none)      | 32-byte key, 64 hex characters or base64. Required with `SBM_STATE_DIR`.              |
| `SBM_MAX_SESSIONS`   | `8`         | Concurrent agent sessions. Each session runs its own Chrome process.                  |
| `SBM_SESSION_IDLE_S` | `1800`      | The broker closes a session, and its browser, after this many idle seconds.           |
| `SBM_CHROME_ARGS`    | (none)      | Extra Chrome flags, separated by spaces. The image sets `--disable-dev-shm-usage`.    |

The `TURNKEY_*` variables and the other `SBM_*` variables work as in the stdio broker. Step 1 uses one Turnkey API key for every session.

`GET /healthz` returns `{"ok":true,"backend":"..."}` without authentication.

## Connect Hermes

Add a `url` entry to the Hermes `config.yaml`:

```yaml
mcp_servers:
  secure-browser:
    url: "https://<broker-host>/mcp"
    headers:
      Authorization: "Bearer <SBM_HTTP_TOKEN>"
```

Check the connection with `hermes mcp test secure-browser`. It must list the same tools as the stdio broker. Install the skill as usual (`bun run skill:install -- --hermes`); the skill does not change.

The hosted browser runs on the broker host. `localhost` in a URL refers to that host, not to the agent's machine, so the local demo fixture works only when the fixture runs beside the broker.

## Sessions

- Each MCP session gets its own Chrome process with a fresh profile, its own redaction registry, and its own element uids. One session cannot see another session's pages, cookies, or snapshots.
- A session sees only the pending fills it parked. `await_fill` with a fill id that belongs to another live session returns `Unknown fill_id`.
- The broker closes a session's browser when the client sends `DELETE`, when the session is idle for `SBM_SESSION_IDLE_S`, and at shutdown.

## Restarts and pending fills

A parked fill holds the export's decryption key. With `SBM_STATE_DIR` set, the broker writes each parked fill to one AES-256-GCM file, encrypted with `SBM_STATE_KEY`, and loads the files at startup.

After a restart, the old MCP session and its browser are gone. The client starts a new session (the broker answers the old session id with 404, as the MCP spec requires). The new session can claim a parked fill by presenting its `fill_id`: the broker gave that random id only to the original session. The old element uids are gone too, so the agent navigates back to the page, takes a snapshot, and calls `await_fill` with the `fill_id` and the new `element_uid` or `fields`. The destination binding is checked again as for any fill.

If the page is not ready when the approval arrives, the broker drops the plaintext and keeps the fill. The agent can call `await_fill` again with new targets; the approved export is redeemed again.

Run one broker process per state directory. Two processes that share a directory do not see each other's writes.

## Container

```sh
docker build -t secure-browser-mcp .
docker run --rm -p 8080:8080 \
  --security-opt seccomp=<chrome-seccomp-profile.json> \
  -e SBM_HTTP_TOKEN -e SBM_STATE_KEY \
  -e TURNKEY_API_PUBLIC_KEY -e TURNKEY_API_PRIVATE_KEY -e TURNKEY_ORGANIZATION_ID \
  -v sbm-state:/var/lib/sbm \
  secure-browser-mcp
```

The image runs Chromium with its sandbox on, as a non-root user. Docker's default seccomp profile blocks the namespaces the Chrome sandbox needs, and Chrome then fails to start (`Target closed`). Use a seccomp profile that permits `clone`, `unshare`, and `setns` for user namespaces. Do not add `--no-sandbox` to `SBM_CHROME_ARGS`: without the sandbox, a compromised renderer can read the broker's memory, which holds plaintext during a fill. For a local check only, `--security-opt seccomp=unconfined` works.

## Deployment requirements

- Terminate TLS in front of the broker. The bearer token and tool results travel in the request and response bodies.
- Restrict egress to the public internet. The agent controls where the browser navigates, so the browser can reach every address the container can reach, including cloud metadata endpoints and internal services.
- Store `SBM_HTTP_TOKEN`, `SBM_STATE_KEY`, and the Turnkey API key in the platform's secret store. Do not put them in the state volume.
- Run one replica per state volume.
