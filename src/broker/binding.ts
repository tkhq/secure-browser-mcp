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

/** Page-side facts the policy needs but cannot compute itself. */
export type BindingProbe = {
  /** Whether the resolved target element matches a CSS selector. */
  elementMatches: (selector: string) => Promise<boolean>;
};

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
  async assertAllowed(
    ref: SecretRef,
    target: FillTarget,
    probe: BindingProbe,
  ): Promise<void> {
    const binding = ref.binding;
    if (!binding) {
      throw new BindingViolationError(
        ref,
        target,
        "secret has no destination binding; unbound secrets are not fillable",
      );
    }

    const url = new URL(target.pageUrl);
    if (url.origin !== binding.origin) {
      throw new BindingViolationError(
        ref,
        target,
        `page origin ${url.origin} does not match bound origin ${binding.origin}`,
      );
    }

    if (binding.urlPattern) {
      const pattern = new URLPattern({
        pathname: binding.urlPattern,
        baseURL: binding.origin,
      });
      if (!pattern.test(target.pageUrl)) {
        throw new BindingViolationError(
          ref,
          target,
          `page path ${url.pathname} does not match bound pattern ${binding.urlPattern}`,
        );
      }
    }

    if (binding.selector) {
      const matches = await probe.elementMatches(binding.selector);
      if (!matches) {
        throw new BindingViolationError(
          ref,
          target,
          `target element${target.selectorInfo ? ` (${target.selectorInfo})` : ""} ` +
            `does not match bound selector ${binding.selector}`,
        );
      }
    }
  }
}
