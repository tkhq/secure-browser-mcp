import { existsSync } from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BindingPolicy } from "./broker/binding.js";
import { MockSecretsClient } from "./broker/mock-secrets.js";
import type { SecretsClient } from "./broker/secrets-client.js";
import {
  dashboardActivityUrl,
  turnkeyClientFromEnv,
} from "./broker/turnkey-env.js";
import { TurnkeySecretsClient } from "./broker/turnkey-secrets.js";
import { BrowserSession } from "./browser/session.js";
import { RedactionRegistry } from "./redaction/registry.js";
import { createServer } from "./server.js";

// Backend selection: Turnkey when credentials are configured, mock otherwise.
// SBM_MOCK_CONSENSUS (comma-separated secret names) makes those mock secrets
// consensus-gated, with approval arriving SBM_MOCK_CONSENSUS_DELAY_MS after
// the first export attempt — enough to exercise the pending → await flow.
function makeSecretsClient(): {
  client: SecretsClient;
  backend: "mock" | "turnkey";
} {
  const apiClient = turnkeyClientFromEnv();
  if (apiClient) {
    return { client: new TurnkeySecretsClient(apiClient), backend: "turnkey" };
  }
  const consensus = process.env["SBM_MOCK_CONSENSUS"];
  const delay = Number(process.env["SBM_MOCK_CONSENSUS_DELAY_MS"] ?? "3000");
  const client = new MockSecretsClient(
    undefined,
    consensus
      ? { consensusNames: consensus.split(","), approvalDelayMs: delay }
      : {},
  );
  return { client, backend: "mock" };
}

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

function findChrome(): string {
  const configured = process.env["SBM_CHROME_PATH"];
  if (configured) return configured;
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      "No Chromium-based browser found; set SBM_CHROME_PATH to an executable",
    );
  }
  return found;
}

async function main(): Promise<void> {
  const { client: secrets, backend } = makeSecretsClient();
  const ctx = {
    secrets,
    backend,
    session: new BrowserSession({
      executablePath: findChrome(),
      headless: process.env["SBM_HEADLESS"] !== "false",
    }),
    registry: new RedactionRegistry(),
    binding: new BindingPolicy(),
    pendingFills: new Map(),
    ...(backend === "turnkey" ? { approvalUrl: dashboardActivityUrl } : {}),
  };

  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP transport; diagnostics go to stderr only.
  console.error(`secure-browser-mcp: listening on stdio (backend: ${backend})`);

  // When the client disconnects, take the browser down with us — an orphaned
  // broker browser is an unowned browser.
  const shutdown = () => {
    void ctx.session.close().finally(() => process.exit(0));
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("secure-browser-mcp: fatal:", err);
  process.exit(1);
});
