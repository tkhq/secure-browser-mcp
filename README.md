<img width="1500" height="500" alt="Secure Browser MCP" src="assets/banner.png" />

<h4 align="center">
    Agents that work behind every login.
</h4>

<p align="center">
  Let an agent log in, check out, and fill any form with credentials it never sees.
</p>

## Features

- **Fill by reference**: The agent holds an opaque secret reference and cannot read the value. It calls `fill_secret`, and Turnkey injects the plaintext straight into the page over raw CDP
- **Zero context leakage**: The secret never enters the model context, the transcript, or logs. Every tool result passes through a single redaction choke point, and an end-to-end test asserts no leak over the wire
- **Destination bindings**: Each secret binds at import to an exact origin, URL pattern, and field selector. A page that talks the agent into filling anywhere else gets a broker-side refusal before any export
- **Consensus approvals**: Turnkey policies encode allow once, allow always, or require N approvers. Approvers sign the export and still cannot read the value, which only an ephemeral key held by the broker can decrypt
- **Secure enclave storage**: Credentials live in Turnkey Secret Storage, so no single party can access them alone. That includes Turnkey, and it includes the agent
- **Cryptographic audit trail**: Every export request, approver, and destination lands as a signed Turnkey activity you can query
- **Any MCP client**: Point Claude Code, Codex, or any agent framework at the server over stdio
- **Skill and evals included**: Ships with an Agent Skill that teaches agents the workflow and an eval harness that runs real headless agent sessions and hard-fails any leak

## Overview

Secure Browser MCP is an MCP server that acts as a credential broker and owns its own browser. The agent drives the browser through a small set of tools. Passwords, cards, and API keys stay in Turnkey Secret Storage until a fill passes policy. The broker then exports the secret, decrypts it in its own process memory, and types it into the bound field. The agent sees only `[REDACTED]`.

Ask an agent to buy something. It navigates to checkout, signs in with a stored password under an allow-always policy, then requests the card. The card requires a second approver, so the fill pauses until a human signs off. The payment succeeds, and the card number never appears in any byte the server sent.
