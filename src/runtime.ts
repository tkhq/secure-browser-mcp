/**
 * Startup wiring shared by the stdio entrypoint (src/index.ts) and the
 * hosted HTTP entrypoint (src/http.ts).
 */
import { existsSync } from "node:fs";

import { BindingPolicy } from "./broker/binding.js";
import { MockSecretsClient } from "./broker/mock-secrets.js";
import type { PendingFills } from "./broker/pending-store.js";
import type { SecretsClient } from "./broker/secrets-client.js";
import {
  dashboardActivityUrl,
  turnkeyClientFromEnv,
} from "./broker/turnkey-env.js";
import { TurnkeySecretsClient } from "./broker/turnkey-secrets.js";
import { BrowserSession } from "./browser/session.js";
import { RedactionRegistry } from "./redaction/registry.js";
import type { ToolContext } from "./tools/tool.js";

// Backend selection: Turnkey when credentials are configured, mock otherwise.
// SBM_MOCK_CONSENSUS (comma-separated secret names) makes those mock secrets
// consensus-gated, with approval arriving SBM_MOCK_CONSENSUS_DELAY_MS after
// the first export attempt — enough to exercise the pending → await flow.
export function makeSecretsClient(): {
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

export function findChrome(): string {
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

/** Broker-wide pieces every agent session shares. */
export type Broker = {
  secrets: SecretsClient;
  backend: "mock" | "turnkey";
  binding: BindingPolicy;
  chromePath: string;
};

export function makeBroker(): Broker {
  const { client, backend } = makeSecretsClient();
  return {
    secrets: client,
    backend,
    binding: new BindingPolicy(),
    chromePath: findChrome(),
  };
}

/** A fresh context for one agent session: its own browser, redaction
 * registry, and view of the pending fills. */
export function sessionContext(
  broker: Broker,
  pendingFills: PendingFills,
): ToolContext {
  const extraArgs = (process.env["SBM_CHROME_ARGS"] ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return {
    secrets: broker.secrets,
    backend: broker.backend,
    binding: broker.binding,
    session: new BrowserSession({
      executablePath: broker.chromePath,
      headless: process.env["SBM_HEADLESS"] !== "false",
      extraArgs,
    }),
    registry: new RedactionRegistry(),
    pendingFills,
    ...(broker.backend === "turnkey"
      ? { approvalUrl: dashboardActivityUrl }
      : {}),
  };
}
