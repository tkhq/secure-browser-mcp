# Secure Browser MCP with Hermes

Start with a local demo: Hermes signs in and completes a fake checkout using stored secret references. No Turnkey account, imported credentials, or real payment is needed. Then connect the same workflow to Turnkey Secrets.

## 1. Install on the machine running Hermes

You need [Hermes with a configured model](https://hermes-agent.nousresearch.com/docs/getting-started/installation), [Bun](https://bun.sh/docs/installation), Git, and Chrome or Chromium. Standard Hermes installations include MCP support. For a custom Hermes installation, follow its [MCP documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/).

```sh
git clone https://github.com/tkhq/secure-browser-mcp.git
cd secure-browser-mcp
bun install --frozen-lockfile
bun run skill:install -- --hermes
bun run hermes:config
```

The installer copies the bundled skill and its tool reference to `~/.hermes/skills/secure-browser`. It refuses to overwrite an existing skill; use `--force` only to replace that installed copy. For a custom Hermes home or profile, set `HERMES_HOME` to that profile's absolute directory before installing. See [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/).

## 2. Connect the server

Copy the YAML printed by `bun run hermes:config` into your Hermes `config.yaml` (default: `~/.hermes/config.yaml`; custom home: `$HERMES_HOME/config.yaml`). If `mcp_servers` already exists, add just its `secure-browser` entry underneath it. Preserve your other settings and servers.

The generated config contains absolute paths to this checkout and Bun, and clears all three Turnkey credential variables for the demo. It prints configuration only; it does not change your Hermes settings. Regenerate it if you move the checkout or Bun.

Hermes starts this stdio server itself. You do not need a separate `bun run dev` process or an HTTP MCP URL. Use the same Hermes profile for the config, skill, and chat.

The broker checks common Chrome, Chromium, Brave, and Edge locations. If yours is elsewhere, add its executable path under this server's `env`:

```yaml
SBM_CHROME_PATH: "/absolute/path/to/chromium"
```

The generated config runs headless. On a desktop, change `SBM_HEADLESS` to `"false"` to watch the broker's separate browser. On a remote host, install Bun, the checkout, and Chromium there; `localhost` below refers to that host.

## 3. Start the demo and verify the connection

In a terminal in the checkout, start the fixture and leave it running:

```sh
bun run demo:fixture
```

It should report `http://localhost:4173/login`. Start a fresh Hermes session in another terminal:

```sh
hermes chat
```

Send this first:

> Load the secure-browser skill. Use the secure-browser MCP server to list secret references. Report their names and destination bindings, without trying to read their values.

The response should report `backend: "mock"`. You should see `demo-login-password` bound to `http://localhost:4173/login*` and `demo-card` bound to `http://localhost:4173/checkout*`, plus two example references. If these are missing, resolve the connection or backend issue before continuing.

## 4. Complete a login and checkout

Send:

> Use only the secure-browser MCP tools for this local demo. Navigate to http://localhost:4173/login, enter demo@example.com as the email, and fill the password using the demo-login-password reference. Submit the login. On checkout, use demo-card to fill number, expiry, and cvc together with fill_secret. Complete any non-secret fields with demo data and submit the fake checkout. Verify the receipt. Never ask me for secret values or use another browser tool to retrieve them.

Success means Hermes uses `fill_secret`, a snapshot masks the filled fields, and the fixture displays a receipt. The fixture accepts demo input; it is a protocol demonstration, not a test of a real site's authentication or payment processing.

Use exactly `http://localhost:4173`. Changing it to `127.0.0.1`, HTTPS, or another port violates the seeded destination bindings. The broker owns a separate browser; Hermes's built-in browser cannot operate on this session.

To exercise approvals, add these entries under the server's `env`, restart Hermes, and repeat the demo:

```yaml
SBM_MOCK_CONSENSUS: "demo-card"
SBM_MOCK_CONSENSUS_DELAY_MS: "3000"
```

The card fill should return `pending_approval`; Hermes should keep the page in place and call `await_fill`. Mock approval arrives automatically after the delay. This does not contact Turnkey or require a human approver.

## 5. Switch to Turnkey Secrets

The local demo proves the connection and fill protocol. For a real backend, you need a Turnkey organization with Secrets enabled and a broker API identity permitted to list and export the intended secrets.

Before importing, navigate to the target page and verify that the broker snapshot includes the intended fields. **Cross-origin iframe fields are unsupported**, including Stripe Elements embedded in merchant pages. The hosted Stripe test-checkout walkthrough is a supported example; embedded card inputs such as those reported on OpenRouter are not. Missing fields can also be hidden behind a tab or accordion: expand it and snapshot again before concluding the page uses an unsupported iframe.

Bindings are immutable after import, and the current tooling has no secret deletion workflow. Verify the exact origin, pathname pattern, and CSS selector on the live page first. A wrong binding requires a new import, preferably under a distinct name so users can identify the corrected reference.

1. Configure the broker credentials and import your credential using [Import your own secret](#import-your-own-secret) below. For a public test-card example, use [the Turnkey test-checkout walkthrough](DEMO-STRIPE.md). Run provisioning yourself, outside the agent conversation.
2. Remove the three empty `TURNKEY_*` overrides from the Hermes MCP entry, along with any `SBM_MOCK_*` settings. Supply `TURNKEY_API_PUBLIC_KEY`, `TURNKEY_API_PRIVATE_KEY`, and `TURNKEY_ORGANIZATION_ID` to the broker process through your runtime's environment configuration. All three must be present: the current server falls back to mock if any is missing. Do not paste private keys or secret values into chat.
3. Restart Hermes from the configured environment. Ask it to call `list_secret_refs` and confirm `backend: "turnkey"`, the imported names, and the intended bindings. If it reports `mock`, check how your Hermes launch process supplies environment variables. Startup diagnostics are also available in the active Hermes home’s `logs/mcp-stderr.log` (normally `~/.hermes/logs/mcp-stderr.log`).
4. Ask Hermes to fill the matching test checkout using those references. A pending export requires the approver to sign the indicated Turnkey activity before `await_fill` can complete. The [README](../README.md#backends) explains the consensus policy.

Keep broker API keys separate from the website credentials stored in Turnkey. Protect the broker's runtime environment from agent shell/file access; browser-tool redaction does not protect keys an agent can read directly from the host. Review the [threat model](THREAT-MODEL.md) before using real credentials.

### Import your own secret

From this checkout, run the importer in your own interactive terminal with all three Turnkey credential variables configured. Load the value into an environment variable through your secret manager or a hidden prompt. Never type a literal secret into an `export` command, pass it as an argument, or paste it into chat.

For a single-line password in Bash or Zsh, this hidden prompt avoids placing the value in shell history:

```sh
printf 'Secret value (hidden): '
read -rs SBM_IMPORT_VALUE
printf '\n'
export SBM_IMPORT_VALUE
bun run scripts/import-secret.ts \
  --name example-login-password \
  --origin https://example.com \
  --url-pattern '/login*' \
  --selector 'input[type=password]' \
  --value-env SBM_IMPORT_VALUE
unset SBM_IMPORT_VALUE
```

Replace the example metadata with the destination you verified. `--value-env` names the variable; it does not contain the value. The importer shows the name and bindings, requires you to type `import`, and returns the `secretId` and committed bindings. It refuses missing Turnkey credentials and noninteractive execution. Cancellation creates nothing. If the API reports a failure, check existing secrets before retrying because the request may have reached Turnkey.

For one JSON secret filling several fields, use `--fields` instead of `--selector`:

```sh
bun run scripts/import-secret.ts \
  --name example-card \
  --origin https://example.com \
  --url-pattern '/checkout*' \
  --fields '{"number":"input[name=cardNumber]","expiry":"input[name=cardExpiry]","cvc":"input[name=cardCvc]"}' \
  --value-env SBM_IMPORT_VALUE
```

Populate the variable securely with a JSON object containing exactly those keys, each with a nonempty string value. The importer validates the shape but cannot verify CSS selectors against a live page. It writes `sbm:origin`, optional `sbm:url-pattern`, and either `sbm:selector` or `sbm:fields` as static properties. Environment variables remain accessible to processes with sufficient host access; use a terminal outside the agent runtime and unset the value afterward.

After updating this checkout, refresh an existing Hermes skill with `bun run skill:install -- --hermes --force`, using the same `HERMES_HOME` as your profile. This replaces the installed skill copy, including local edits.

## Troubleshooting

| Symptom                                     | Next step                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No secret reference for the target site     | Call `list_secret_refs` and check `backend`. Mock contains fixed demo seeds; switch to Turnkey and use the importer above. The MCP tools cannot import secrets. |
| Card/password fields absent from `snapshot` | Expand any hidden form controls and snapshot again. Cross-origin iframe fields are unsupported; importing another secret cannot make them reachable.            |
| No secure-browser tools                     | Check the active profile's config and YAML indentation, then restart Hermes. Confirm the generated Bun and checkout paths still exist.                          |
| Skill is missing                            | Install it into the same Hermes home/profile used for chat. The skill and MCP connection are separate setup steps.                                              |
| No Chromium-based browser found             | Install a supported browser or set `SBM_CHROME_PATH` to its executable on the Hermes host.                                                                      |
| Browser fails on a remote machine           | Keep `SBM_HEADLESS: "true"` and check the host's Chromium installation and required system libraries.                                                           |
| Navigation fails                            | Keep `bun run demo:fixture` running on the Hermes host. Use `/login`; the fixture root `/` returns 404.                                                         |
| Port 4173 is occupied                       | Stop your previous fixture process. Changing the port also requires changing secret bindings.                                                                   |
| Binding refusal                             | Check the secret's origin, URL pattern, and selector. Do not bypass the refusal or send the value through `type_text`.                                          |
| Approval stays pending                      | Mock mode: check the delay setting. Turnkey mode: have the designated approver check the activity and policy. Keep the target page unchanged.                   |
| Agent uses another browser                  | Explicitly load the secure-browser skill and request this MCP server's tools; browser sessions are separate.                                                    |

When finished, exit Hermes and stop the fixture with Ctrl-C. To disconnect permanently, remove the `secure-browser` MCP entry and its installed skill folder from the active Hermes home.
