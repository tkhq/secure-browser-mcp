import { generateP256KeyPair } from "@turnkey/crypto";
import type { TurnkeyApiClient } from "@turnkey/sdk-server";

import {
  ConsensusNeededError,
  ConsensusPendingError,
  type PendingExport,
  type SecretsClient,
} from "./secrets-client.js";
import type { ExportedSecret, SecretRef } from "./types.js";
import { parseBinding } from "./mock-secrets.js";

/** Proposal shape returned by createExportSecretsProposal; the broker only
 * needs to carry it opaquely between submit and await. */
type Proposal = ReturnType<TurnkeyApiClient["createExportSecretsProposal"]>;

const TERMINAL_FAILURE = new Set([
  "ACTIVITY_STATUS_REJECTED",
  "ACTIVITY_STATUS_FAILED",
]);

/**
 * Thin adapter over @turnkey/sdk-server's Secrets API (tkhq/sdk#1479).
 *
 * The export runs the proposal flow manually rather than via the SDK's
 * one-shot `exportSecret`: that helper discards its ephemeral decryption key
 * when consensus is needed, leaving the pending activity unredeemable. Here
 * the key is retained in broker memory, keyed by activity id, so the fill
 * can complete once approvers reach quorum. Keys never leave this class and
 * die with the process.
 */
export class TurnkeySecretsClient implements SecretsClient {
  /** activityId → the material needed to redeem the export after approval. */
  private readonly held = new Map<
    string,
    { proposal: Proposal; privateKey: string }
  >();

  constructor(private readonly client: TurnkeyApiClient) {}

  async listRefs(): Promise<SecretRef[]> {
    const secrets = await this.client.getSecrets({});
    return secrets.map((s) => {
      const ref: SecretRef = {
        secretId: s.secretId,
        staticProperties: s.staticProperties,
      };
      if (s.name !== undefined) ref.name = s.name;
      const binding = parseBinding(s.staticProperties);
      if (binding) ref.binding = binding;
      return ref;
    });
  }

  async exportSecret(ref: SecretRef): Promise<ExportedSecret> {
    const { privateKey, publicKeyUncompressed } = generateP256KeyPair();
    const proposal = this.client.createExportSecretsProposal({
      secrets: [{ secretId: ref.secretId }],
      targetPublicKey: publicKeyUncompressed,
      timestampMs: String(Date.now()),
    });
    const submitted = await this.client.submitExportSecrets(proposal);

    if (submitted.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED") {
      this.held.set(submitted.activityId, { proposal, privateKey });
      throw new ConsensusNeededError(ref.secretId, {
        ref,
        activityId: submitted.activityId,
        fingerprint: submitted.fingerprint,
      });
    }

    return this.redeem(ref, proposal, submitted.activityId, privateKey);
  }

  async awaitExport(
    pending: PendingExport,
    timeoutMs: number,
  ): Promise<ExportedSecret> {
    const held = this.held.get(pending.activityId);
    if (!held) {
      throw new Error(
        `No decryption key held for activity ${pending.activityId} — the ` +
          `broker restarted since the export was proposed. Start a new fill.`,
      );
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { activity } = await this.client.getActivity({
        organizationId: held.proposal.organizationId,
        activityId: pending.activityId,
      });
      if (activity.status === "ACTIVITY_STATUS_COMPLETED") {
        this.held.delete(pending.activityId);
        return this.redeem(
          pending.ref,
          held.proposal,
          pending.activityId,
          held.privateKey,
        );
      }
      if (TERMINAL_FAILURE.has(activity.status)) {
        this.held.delete(pending.activityId);
        throw new Error(
          `Export of ${pending.ref.secretId} ended ${activity.status} ` +
            `(activity ${pending.activityId})`,
        );
      }
      if (Date.now() >= deadline) throw new ConsensusPendingError(pending);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  /** Decrypt a completed export with the retained ephemeral key. */
  private async redeem(
    ref: SecretRef,
    proposal: Proposal,
    activityId: string,
    privateKey: string,
  ): Promise<ExportedSecret> {
    const [value] = await this.client.awaitExportedSecrets({
      proposal,
      activityId,
      embeddedPrivateKey: privateKey,
    });
    if (value === undefined) {
      throw new Error(`Export of ${ref.secretId} returned no payload`);
    }
    return { ref, value, release: () => {} };
  }
}
