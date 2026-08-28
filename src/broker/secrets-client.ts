import type { ExportedSecret, SecretRef } from "./types.js";

/**
 * A consensus-gated export waiting on approvals. Safe to hold in broker
 * memory and to surface BY ID to the agent; the decryption key it corresponds
 * to stays inside the SecretsClient implementation and dies with the broker
 * process — a restart makes the pending export unredeemable by design.
 */
export interface PendingExport {
  ref: SecretRef;
  /** Turnkey activity id approvers act on (mock ids in the mock backend). */
  activityId: string;
  fingerprint: string;
}

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
 *
 * When the export needs multi-party approval, `exportSecret` throws
 * `ConsensusNeededError` carrying a `PendingExport`; `awaitExport` redeems it
 * once approvers reach quorum (or throws `ConsensusPendingError` when the
 * timeout passes first — the pending export stays valid and can be awaited
 * again).
 */
export interface SecretsClient {
  listRefs(): Promise<SecretRef[]>;
  exportSecret(ref: SecretRef): Promise<ExportedSecret>;
  awaitExport(
    pending: PendingExport,
    timeoutMs: number,
  ): Promise<ExportedSecret>;
}

/** Thrown when an export needs multi-party approval before it can complete. */
export class ConsensusNeededError extends Error {
  constructor(
    public readonly secretId: string,
    public readonly pending?: PendingExport,
    public readonly detail?: string,
  ) {
    super(
      `Export of ${secretId} requires consensus approval` +
        (detail ? `: ${detail}` : ""),
    );
    this.name = "ConsensusNeededError";
  }
}

/** Thrown by `awaitExport` when the timeout passes with approvals still
 * outstanding. Not a failure: the pending export remains redeemable. */
export class ConsensusPendingError extends Error {
  constructor(public readonly pending: PendingExport) {
    super(
      `Export of ${pending.ref.secretId} is still awaiting approval ` +
        `(activity ${pending.activityId})`,
    );
    this.name = "ConsensusPendingError";
  }
}
