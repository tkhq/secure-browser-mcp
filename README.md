# secure-browser-mcp

An MCP server that fills secrets into a browser without showing them to the agent.

The agent sees secret references, not secret values. Secrets live in [Turnkey Secrets](https://docs.turnkey.com/features/secrets). The server exports a secret, decrypts it in its own memory, and types it into the page over CDP. The value never enters the conversation, the transcript, or the model context.

It covers the secrets that cannot be proxied through an API: passwords, card numbers, and SSNs typed into web forms.

**Status: scaffold.** The interfaces, tool surface, and security boundaries are in place. Most handlers return `not_implemented`. See [docs/DESIGN.md](docs/DESIGN.md) for the full design and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) for what this does and does not defend against.

## How it works

1. The agent calls `list_secret_refs` and gets ids, names, and destination bindings. No values.
2. The agent drives the browser with `navigate`, `snapshot`, `click`, and `type_text`.
3. The agent calls `fill_secret(secret_id, element_uid)`.
4. The server checks the page against the secret's destination binding. The binding is set at import time through Turnkey static properties and cannot be changed.
5. The server exports the secret from Turnkey (ephemeral P-256 key, HPKE), types it into the field over CDP, and drops the value.
6. Every tool result passes through a redaction layer before it reaches the agent. Snapshots, network logs, and screenshots never echo a filled value.

There is no `evaluate_script` tool. That is a security decision, not a gap.

## Quickstart

```sh
bun install
bun run typecheck
bun run dev          # starts the MCP server on stdio (mock secrets backend)
```

Inspect the tool surface:

```sh
bunx @modelcontextprotocol/inspector bun src/index.ts
```

The server uses an in-memory mock backend until Turnkey credentials are configured. The real backend is a thin adapter over `@turnkey/sdk-server` (`importSecret` / `exportSecret` / `getSecrets`, merged in [tkhq/sdk#1479](https://github.com/tkhq/sdk/pull/1479)).

## Dependencies on unpublished SDK code

The Secrets API methods are on `tkhq/sdk` main but not on npm yet. The `vendor/` directory holds tarballs packed from a local `../sdk` checkout, pinned through `overrides` in `package.json`. Remove the vendor tarballs and the overrides once `@turnkey/sdk-server@8.3.0` ships.

To regenerate the tarballs:

```sh
cd ../sdk && pnpm install && pnpm turbo build --filter=@turnkey/sdk-server --filter=@turnkey/crypto
cd packages/<pkg> && pnpm pack --out ../../../secure-browser-mcp/vendor/turnkey-<pkg>.tgz
```

## Layout

| Path             | What it holds                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `src/broker/`    | Secret refs, the `SecretsClient` interface, Turnkey and mock backends, destination-binding policy |
| `src/browser/`   | Browser ownership and CDP secret injection                                                        |
| `src/redaction/` | The scrub layer every tool result passes through                                                  |
| `src/tools/`     | One file per MCP tool                                                                             |
| `docs/`          | Design and threat model                                                                           |
