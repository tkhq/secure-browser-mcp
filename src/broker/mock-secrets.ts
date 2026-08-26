import type { SecretsClient } from "./secrets-client.js";
import type { ExportedSecret, SecretRef } from "./types.js";
import { BINDING_KEYS, type SecretBinding } from "./types.js";

type MockSecret = {
  name: string;
  value: string;
  staticProperties: Record<string, string>;
};

/** Parse a destination binding from static properties, if one is declared. */
export function parseBinding(
  staticProperties: Record<string, string>,
): SecretBinding | undefined {
  const origin = staticProperties[BINDING_KEYS.origin];
  if (!origin) return undefined;
  const binding: SecretBinding = { origin };
  const urlPattern = staticProperties[BINDING_KEYS.urlPattern];
  if (urlPattern) binding.urlPattern = urlPattern;
  const selector = staticProperties[BINDING_KEYS.selector];
  if (selector) binding.selector = selector;
  return binding;
}

/**
 * In-memory secrets backend for development until Secrets API beta access /
 * a published SDK release. Mirrors the shapes of `TurnkeySecretsClient`.
 */
export class MockSecretsClient implements SecretsClient {
  private readonly secrets = new Map<string, MockSecret>();

  constructor(seed?: MockSecret[]) {
    for (const [i, s] of (seed ?? DEFAULT_SEED).entries()) {
      this.secrets.set(`mock-secret-${i + 1}`, s);
    }
  }

  async listRefs(): Promise<SecretRef[]> {
    return [...this.secrets.entries()].map(([secretId, s]) => {
      const ref: SecretRef = {
        secretId,
        name: s.name,
        staticProperties: s.staticProperties,
      };
      const binding = parseBinding(s.staticProperties);
      if (binding) ref.binding = binding;
      return ref;
    });
  }

  async exportSecret(ref: SecretRef): Promise<ExportedSecret> {
    const secret = this.secrets.get(ref.secretId);
    if (!secret) throw new Error(`Unknown secret: ${ref.secretId}`);
    return { ref, value: secret.value, release: () => {} };
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
