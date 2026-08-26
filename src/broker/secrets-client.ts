import type { ExportedSecret, SecretRef } from "./types.js";

/**
 * The broker's view of a secrets backend.
 *
 * Implementations: `TurnkeySecretsClient` (real, via @turnkey/sdk-server) and
 * `MockSecretsClient` (in-memory, for development).
 *
 * `exportSecret` resolves with plaintext held in broker memory only. Callers
 * MUST route the value straight to the injector and call `release()`;
 * returning it from an MCP tool handler is a contract violation (and the
 * redaction layer exists to catch exactly that mistake).
 */
export interface SecretsClient {
  listRefs(): Promise<SecretRef[]>;
  exportSecret(ref: SecretRef): Promise<ExportedSecret>;
}

/** Thrown when an export needs multi-party approval before it can complete. */
export class ConsensusNeededError extends Error {
  constructor(
    public readonly secretId: string,
    public readonly detail?: string,
  ) {
    super(
      `Export of ${secretId} requires consensus approval` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "ConsensusNeededError";
  }
}
