/**
 * Startup wiring shared by the stdio entrypoint (src/index.ts) and the
 * hosted HTTP entrypoint (src/http.ts).
 */
import { existsSync } from "node:fs";

import { resolveApiKey, type TenantConfig } from "./auth/tenants.js";
import { BindingPolicy } from "./broker/binding.js";
import { MockSecretsClient } from "./broker/mock-secrets.js";
import type { PendingFills } from "./broker/pending-store.js";
import type { SecretsClient } from "./broker/secrets-client.js";
import {
  dashboardActivityUrl,
  turnkeyClient,
  turnkeyClientFromEnv,
} from "./broker/turnkey-env.js";
import { TurnkeySecretsClient } from "./broker/turnkey-secrets.js";
import {
  BrowserbaseHost,
  LocalChromeHost,
  type BrowserHost,
} from "./browser/hosts.js";
import { BrowserSession } from "./browser/session.js";
import { RedactionRegistry } from "./redaction/registry.js";
import type { ToolContext } from "./tools/tool.js";

// Backend selection: Turnkey when credentials are configured, mock otherwise.
// SBM_MOCK_CONSENSUS (comma-separated secret names) makes those mock secrets
// consensus-gated, with approval arriving SBM_MOCK_CONSENSUS_DELAY_MS after
// the first export attempt — enough to exercise the pending → await flow.
export type Secrets = {
  client: SecretsClient;
  backend: "mock" | "turnkey";
};

export function makeSecretsClient(): Secrets {
  const apiClient = turnkeyClientFromEnv();
  if (apiClient) {
    return { client: new TurnkeySecretsClient(apiClient), backend: "turnkey" };
  }
  return { client: mockFromEnv(), backend: "mock" };
}

function mockFromEnv(seed?: TenantMockSeed): MockSecretsClient {
  const consensus = process.env["SBM_MOCK_CONSENSUS"];
  const delay = Number(process.env["SBM_MOCK_CONSENSUS_DELAY_MS"] ?? "3000");
  return new MockSecretsClient(
    seed,
    consensus
      ? { consensusNames: consensus.split(","), approvalDelayMs: delay }
      : {},
  );
}

type TenantMockSeed = Extract<TenantConfig, { backend: "mock" }>["mockSecrets"];

/** The secrets a hosted tenant's sessions see: its own Turnkey
 * organization, through its own API key. */
export function tenantSecretsClient(tenant: TenantConfig): Secrets {
  if (tenant.backend === "mock") {
    return { client: mockFromEnv(tenant.mockSecrets), backend: "mock" };
  }
  const apiClient = turnkeyClient({
    ...resolveApiKey(tenant),
    organizationId: tenant.organizationId,
  });
  return { client: new TurnkeySecretsClient(apiClient), backend: "turnkey" };
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
  /** Builds one browser host per agent session. */
  browserHost: () => BrowserHost;
  browser: "local" | "browserbase";
};

/**
 * SBM_BROWSER picks where session browsers run: "local" (default; Chrome on
 * this machine) or "browserbase" (BROWSERBASE_API_KEY, optional
 * BROWSERBASE_PROJECT_ID and SBM_BROWSERBASE_TIMEOUT_S).
 */
function browserHostFromEnv(): Pick<Broker, "browserHost" | "browser"> {
  const kind = process.env["SBM_BROWSER"] ?? "local";
  if (kind === "browserbase") {
    const apiKey = process.env["BROWSERBASE_API_KEY"];
    if (!apiKey)
      throw new Error("SBM_BROWSER=browserbase needs BROWSERBASE_API_KEY");
    const projectId = process.env["BROWSERBASE_PROJECT_ID"];
    const timeout = Number(process.env["SBM_BROWSERBASE_TIMEOUT_S"] ?? "");
    return {
      browser: "browserbase",
      browserHost: () =>
        new BrowserbaseHost({
          apiKey,
          ...(projectId ? { projectId } : {}),
          ...(timeout > 0 ? { timeoutSeconds: timeout } : {}),
        }),
    };
  }
  if (kind !== "local") {
    throw new Error(
      `SBM_BROWSER must be "local" or "browserbase", not "${kind}"`,
    );
  }
  const executablePath = findChrome();
  const headless = process.env["SBM_HEADLESS"] !== "false";
  const extraArgs = (process.env["SBM_CHROME_ARGS"] ?? "")
    .split(/\s+/)
    .filter(Boolean);
  return {
    browser: "local",
    browserHost: () =>
      new LocalChromeHost({ executablePath, headless, extraArgs }),
  };
}

/** A broker over `secrets`, by default the TURNKEY_* key (or the mock). */
export function makeBroker(
  { client, backend }: Secrets = makeSecretsClient(),
): Broker {
  return {
    secrets: client,
    backend,
    binding: new BindingPolicy(),
    ...browserHostFromEnv(),
  };
}

/** A fresh context for one agent session: its own browser, redaction
 * registry, and view of the pending fills. */
export function sessionContext(
  broker: Broker,
  pendingFills: PendingFills,
): ToolContext {
  return {
    secrets: broker.secrets,
    backend: broker.backend,
    binding: broker.binding,
    session: new BrowserSession(broker.browserHost()),
    registry: new RedactionRegistry(),
    pendingFills,
    ...(broker.backend === "turnkey"
      ? { approvalUrl: dashboardActivityUrl }
      : {}),
  };
}
