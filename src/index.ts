import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BindingPolicy } from "./broker/binding.js";
import { MockSecretsClient } from "./broker/mock-secrets.js";
import type { SecretsClient } from "./broker/secrets-client.js";
import { BrowserSession } from "./browser/session.js";
import { RedactionRegistry } from "./redaction/registry.js";
import { createServer } from "./server.js";

// Backend selection: Turnkey when credentials are configured, mock otherwise.
// TODO(scaffold): wire TurnkeySecretsClient —
//   new Turnkey({ apiBaseUrl, apiPrivateKey, apiPublicKey,
//                 defaultOrganizationId }).apiClient()
// from TURNKEY_* env vars once beta access is enabled for the org.
function makeSecretsClient(): SecretsClient {
  return new MockSecretsClient();
}

async function main(): Promise<void> {
  const ctx = {
    secrets: makeSecretsClient(),
    session: new BrowserSession({
      executablePath:
        process.env["SBM_CHROME_PATH"] ??
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: process.env["SBM_HEADLESS"] !== "false",
    }),
    registry: new RedactionRegistry(),
    binding: new BindingPolicy(),
  };

  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP transport; diagnostics go to stderr only.
  console.error("secure-browser-mcp: listening on stdio (backend: mock)");
}

main().catch((err) => {
  console.error("secure-browser-mcp: fatal:", err);
  process.exit(1);
});
