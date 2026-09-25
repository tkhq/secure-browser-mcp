import {
  ConsensusNeededError,
  ConsensusPendingError,
  type PendingExport,
  type SecretsClient,
} from "./secrets-client.js";
import type { ExportedSecret, SecretRef } from "./types.js";
import { BINDING_KEYS, type SecretBinding } from "./types.js";

type MockSecret = {
  name: string;
  value: string;
  staticProperties: Record<string, string>;
};

type MockOptions = {
  /** Secret names whose export simulates a consensus gate. */
  consensusNames?: string[];
  /** How long after the first export attempt approval "arrives". */
  approvalDelayMs?: number;
};

/**
 * Parse a destination binding from static properties. Returns `{}` when no
 * `sbm:origin` is declared, and `{ bindingError }` when a declared part is
 * malformed. A malformed part never falls back to a looser binding: a bad
 * `sbm:fields` must not turn a card secret into an origin-only one.
 */
export function parseBinding(
  staticProperties: Record<string, string>,
): Pick<SecretRef, "binding" | "bindingError"> {
  const origin = staticProperties[BINDING_KEYS.origin];
  if (origin === undefined) return {};
  const invalid = (reason: string) => ({ bindingError: reason });

  let parsedOrigin: string;
  try {
    parsedOrigin = new URL(origin).origin;
  } catch {
    return invalid(`${BINDING_KEYS.origin} is not a URL`);
  }
  if (parsedOrigin === "null" || parsedOrigin !== origin) {
    return invalid(
      `${BINDING_KEYS.origin} must be an origin like https://example.com`,
    );
  }
  const binding: SecretBinding = { origin };

  const urlPattern = staticProperties[BINDING_KEYS.urlPattern];
  if (urlPattern !== undefined) {
    try {
      new URLPattern({ pathname: urlPattern, baseURL: origin });
    } catch {
      return invalid(`${BINDING_KEYS.urlPattern} is not a valid URL pattern`);
    }
    binding.urlPattern = urlPattern;
  }

  const selector = staticProperties[BINDING_KEYS.selector];
  if (selector !== undefined) {
    if (!selector.trim()) return invalid(`${BINDING_KEYS.selector} is empty`);
    binding.selector = selector;
  }

  const fields = staticProperties[BINDING_KEYS.fields];
  if (fields !== undefined) {
    let map: unknown;
    try {
      map = JSON.parse(fields);
    } catch {
      return invalid(`${BINDING_KEYS.fields} is not JSON`);
    }
    const entries =
      map && typeof map === "object" && !Array.isArray(map)
        ? Object.entries(map)
        : [];
    if (
      entries.length === 0 ||
      entries.some(([k, v]) => !k || typeof v !== "string" || !v.trim())
    ) {
      return invalid(
        `${BINDING_KEYS.fields} must map payload keys to CSS selectors`,
      );
    }
    binding.fields = Object.fromEntries(entries) as Record<string, string>;
  }
  return { binding };
}

/**
 * In-memory secrets backend for development until Secrets API beta access /
 * a published SDK release. Mirrors the shapes of `TurnkeySecretsClient`.
 */
export class MockSecretsClient implements SecretsClient {
  private readonly secrets = new Map<string, MockSecret>();
  private readonly consensusNames: Set<string>;
  private readonly approvalDelayMs: number;
  /** secretId → when the first export attempt happened; approval "arrives"
   * approvalDelayMs later, simulating an out-of-band approver. */
  private readonly pendingSince = new Map<string, number>();

  constructor(seed?: MockSecret[], opts?: MockOptions) {
    for (const [i, s] of (seed ?? DEFAULT_SEED).entries()) {
      this.secrets.set(`mock-secret-${i + 1}`, s);
    }
    this.consensusNames = new Set(opts?.consensusNames ?? []);
    this.approvalDelayMs = opts?.approvalDelayMs ?? 3_000;
  }

  async listRefs(): Promise<SecretRef[]> {
    return [...this.secrets.entries()].map(([secretId, s]) => {
      const ref: SecretRef = {
        secretId,
        name: s.name,
        staticProperties: s.staticProperties,
      };
      Object.assign(ref, parseBinding(s.staticProperties));
      return ref;
    });
  }

  async exportSecret(ref: SecretRef): Promise<ExportedSecret> {
    const secret = this.secrets.get(ref.secretId);
    if (!secret) throw new Error(`Unknown secret: ${ref.secretId}`);
    if (this.consensusNames.has(secret.name) && !this.isApproved(ref)) {
      if (!this.pendingSince.has(ref.secretId)) {
        this.pendingSince.set(ref.secretId, Date.now());
      }
      throw new ConsensusNeededError(ref.secretId, this.pendingHandle(ref));
    }
    return { ref, value: secret.value, release: () => {} };
  }

  async awaitExport(
    pending: PendingExport,
    timeoutMs: number,
  ): Promise<ExportedSecret> {
    const secret = this.secrets.get(pending.ref.secretId);
    const since = this.pendingSince.get(pending.ref.secretId);
    if (!secret || since === undefined) {
      throw new Error(`No pending export for ${pending.ref.secretId}`);
    }
    const approvedAt = since + this.approvalDelayMs;
    const wait = approvedAt - Date.now();
    if (wait > timeoutMs) {
      await new Promise((r) => setTimeout(r, timeoutMs));
      throw new ConsensusPendingError(pending);
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return { ref: pending.ref, value: secret.value, release: () => {} };
  }

  private isApproved(ref: SecretRef): boolean {
    const since = this.pendingSince.get(ref.secretId);
    return since !== undefined && Date.now() >= since + this.approvalDelayMs;
  }

  private pendingHandle(ref: SecretRef): PendingExport {
    return {
      ref,
      activityId: `mock-activity-${ref.secretId}`,
      fingerprint: `mock-fingerprint-${ref.secretId}`,
    };
  }
}

const DEFAULT_SEED: MockSecret[] = [
  {
    // Bound to the local demo fixture (test/fixtures/login.html served on
    // port 4173) so the end-to-end demo works out of the box.
    name: "demo-login-password",
    value: "mock-demo-p@ssw0rd-1234",
    staticProperties: {
      [BINDING_KEYS.origin]: "http://localhost:4173",
      [BINDING_KEYS.urlPattern]: "/login*",
      [BINDING_KEYS.selector]: "input[type=password]",
    },
  },
  // A fake card for the fixture checkout page as ONE JSON-payload secret
  // (Stripe's PUBLIC test values, docs.stripe.com/testing — safe anywhere):
  // one export and one approval fill all three fields. Mirrors the prod
  // demo secret.
  {
    name: "demo-card",
    value: JSON.stringify({
      number: "4242424242424242",
      expiry: "1234",
      cvc: "123",
    }),
    staticProperties: {
      [BINDING_KEYS.origin]: "http://localhost:4173",
      [BINDING_KEYS.urlPattern]: "/checkout*",
      [BINDING_KEYS.fields]: JSON.stringify({
        number: "input[name=cardNumber]",
        expiry: "input[name=cardExpiry]",
        cvc: "input[name=cardCvc]",
      }),
    },
  },
  {
    name: "example-login-password",
    value: "mock-hunter2-do-not-use",
    staticProperties: {
      [BINDING_KEYS.origin]: "https://example.com",
      [BINDING_KEYS.urlPattern]: "/login*",
      [BINDING_KEYS.selector]: "input[type=password]",
    },
  },
  {
    name: "example-api-key",
    value: "mock-sk-0000",
    staticProperties: {
      [BINDING_KEYS.origin]: "https://dashboard.example.com",
    },
  },
];
