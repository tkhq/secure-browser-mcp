---
title: Set up Secure Browser MCP
canonical: https://tkhq.github.io/secure-browser-mcp/setup.html
html: https://tkhq.github.io/secure-browser-mcp/setup.html
---

# Set up Secure Browser MCP

Install the server, connect it to an MCP client, and try the local storefront.

## Prerequisites

- [Bun](https://bun.sh)
- A Chromium-based browser. `SBM_CHROME_PATH` takes priority, followed by common Chrome, Chromium, Brave, and Edge locations.
- For production secrets, Turnkey Secrets access and API credentials. The mock backend does not need them.

## 1. Install and verify

```sh
git clone https://github.com/tkhq/secure-browser-mcp.git
cd secure-browser-mcp
bun install
bun test
```

The suite drives a local storefront and asserts that plaintext does not reach server output.

## 2. Add the MCP server

Claude Code can launch the server directly over stdio:

```sh
claude mcp add secure-browser -- bun run /path/to/secure-browser-mcp/src/index.ts
bun run skill:install -- --claude
```

Use `--codex` instead to install the bundled skill for Codex. The server works with any MCP client that supports stdio.

## 3. Try the fixture

```sh
bun run demo:fixture
# In a second terminal:
bun run dev
```

Open `http://localhost:4173`. It includes login and checkout routes with seeded mock secrets.

## 4. Use Turnkey Secrets

```sh
export TURNKEY_API_PUBLIC_KEY=...
export TURNKEY_API_PRIVATE_KEY=...
export TURNKEY_ORGANIZATION_ID=...
```

Keep API credentials outside MCP configuration and transcripts. A secret is fillable only after it has an immutable destination binding.

## Read next

- [Workflow guide](docs.md) ([HTML](docs.html))
- [MCP reference](reference.md) ([HTML](reference.html))
