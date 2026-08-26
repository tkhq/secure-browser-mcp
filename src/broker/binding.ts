import type { FillTarget, SecretRef } from "./types.js";

/** Thrown when a fill is attempted outside the secret's declared destination. */
export class BindingViolationError extends Error {
  constructor(ref: SecretRef, target: FillTarget, reason: string) {
    super(
      `Refusing to fill "${ref.name ?? ref.secretId}" into ${target.pageUrl}: ${reason}`,
    );
    this.name = "BindingViolationError";
  }
}

/**
 * Destination-binding enforcement — the broker-side prompt-injection defense.
 * A malicious page can talk the agent into *requesting* a fill, but the fill
 * only proceeds when the live page matches the binding baked into the
 * secret's static properties at import time.
 *
 * Longer-term the same check moves into Turnkey's policy engine (static
 * properties are policy-visible), making even the export unobtainable for a
 * non-matching destination.
 */
export class BindingPolicy {
  /** Throws `BindingViolationError` unless the fill target satisfies the binding. */
  assertAllowed(ref: SecretRef, target: FillTarget): void {
    if (!ref.binding) {
      throw new BindingViolationError(
        ref,
        target,
        "secret has no destination binding; unbound secrets are not fillable",
      );
    }
    // TODO(scaffold): implement —
    //   1. origin: exact match of new URL(target.pageUrl).origin
    //   2. urlPattern: URLPattern test against pathname+search
    //   3. selector: resolved element must match binding.selector
    throw new Error("not_implemented: BindingPolicy.assertAllowed");
  }
}
