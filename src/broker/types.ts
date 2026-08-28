/**
 * Core broker types.
 *
 * The invariant everything here serves: secret PLAINTEXT exists only inside
 * the broker process and the target page. The agent (MCP client / LLM) only
 * ever handles `SecretRef`s.
 */

/**
 * Well-known keys for Turnkey secret `staticProperties`. Static properties
 * are bound immutably to a secret at import time and are policy-visible, so
 * bindings expressed through them are enforced both broker-side (here) and,
 * eventually, by Turnkey's policy engine on the export activity itself.
 */
export const BINDING_KEYS = {
  /** Required. Exact origin the secret may be filled into, e.g. "https://github.com". */
  origin: "sbm:origin",
  /** Optional. URL pattern (URLPattern syntax) narrowing beyond origin, e.g. "/login*". */
  urlPattern: "sbm:url-pattern",
  /** Optional. CSS selector the target field must match, e.g. "input[type=password]". */
  selector: "sbm:selector",
  /**
   * Optional. For secrets whose value is a JSON object filled into several
   * fields under ONE export (one approval): a JSON-encoded map from payload
   * key to the CSS selector its field must match, e.g.
   * `{"number":"input[name=cardNumber]","cvc":"input[name=cardCvc]"}`.
   */
  fields: "sbm:fields",
} as const;

/** Destination binding parsed out of a secret's static properties. */
export type SecretBinding = {
  origin: string;
  urlPattern?: string;
  selector?: string;
  /** Per-payload-key selectors for JSON multi-field secrets. */
  fields?: Record<string, string>;
};

/**
 * The agent-visible handle for a secret. Contains metadata only — never the
 * secret value. Safe to serialize into tool results.
 */
export type SecretRef = {
  secretId: string;
  name?: string;
  /** Full static properties, including non-binding ones. */
  staticProperties: Record<string, string>;
  /** Parsed destination binding, if the static properties declare one. */
  binding?: SecretBinding;
};

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

/** Element info the binding policy evaluates a fill against. */
export type FillTarget = {
  pageUrl: string;
  /** Stable element handle from the most recent snapshot. */
  elementUid: string;
  /** Resolved element facts (tag, type, name/id, matched selector), if known. */
  selectorInfo?: string;
};
