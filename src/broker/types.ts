/**
 * Core broker types.
 *
 * The invariant everything here serves: secret PLAINTEXT exists only inside
 * the broker process and the target page. The agent (MCP client / LLM) only
 * ever handles `SecretRef`s.
 */

/**
 * Secret references and destination bindings come from
 * @turnkey/browser-secrets, so the broker and other hosts parse the same
 * `sbm:*` static properties the same way. Static properties are bound
 * immutably to a Turnkey secret at import time and are policy-visible.
 */
export {
  BINDING_KEYS,
  type SecretBinding,
  type SecretRef,
} from "@turnkey/browser-secrets";
import type { SecretRef } from "@turnkey/browser-secrets";

/**
 * Broker-internal carrier for exported plaintext. Never serialized into a
 * tool result; consumed by the injector and then released.
 *
 * Note: JS cannot reliably zeroize strings (see tkhq/sdk#1479 design notes).
 * `release()` drops references so the value becomes collectable; the real
 * memory-safety story is process isolation (v1) and TVC enclaves (v2).
 */
export type ExportedSecret = {
  ref: SecretRef;
  value: string;
  release: () => void;
};
