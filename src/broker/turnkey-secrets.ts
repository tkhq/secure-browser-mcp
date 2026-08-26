import type { TurnkeyApiClient } from "@turnkey/sdk-server";

import { ConsensusNeededError, type SecretsClient } from "./secrets-client.js";
import type { ExportedSecret, SecretRef } from "./types.js";
import { parseBinding } from "./mock-secrets.js";

/**
 * Thin adapter over @turnkey/sdk-server's Secrets API (tkhq/sdk#1479):
 * `getSecrets()` → refs, `exportSecret()` → plaintext in broker memory.
 *
 * The SDK handles the whole export handshake internally (ephemeral P-256
 * target key, HPKE decryption, quorum-signature verification), so this class
 * only maps shapes and error semantics.
 */
export class TurnkeySecretsClient implements SecretsClient {
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
    try {
      const value = await this.client.exportSecret({ secretId: ref.secretId });
      return { ref, value, release: () => {} };
    } catch (err) {
      if (isConsensusNeeded(err)) {
        // TODO: consensus flow — createExportSecretsProposal /
        // submitExportSecrets / awaitExportedSecrets, surfaced to the agent
        // as an MCP Task handle (2026-07-28 RC Tasks extension) so approvers
        // can sign while the agent polls. See docs/DESIGN.md.
        throw new ConsensusNeededError(ref.secretId, String(err));
      }
      throw err;
    }
  }
}

function isConsensusNeeded(err: unknown): boolean {
  // @turnkey/sdk-types error code EXPORT_SECRET_CONSENSUS_NEEDED.
  return (
    err instanceof Error && err.message.includes("EXPORT_SECRET_CONSENSUS")
  );
}
