import type { Page } from "puppeteer-core";

import type { ExportedSecret, FillTarget } from "../broker/types.js";
import type { RedactionRegistry } from "../redaction/registry.js";

/**
 * The one function that handles plaintext: focuses the bound element and
 * types the secret via CDP `Input.insertText` (raw CDP, not page JS — the
 * value must never transit `Runtime.evaluate`, whose expressions end up in
 * agent-visible tool code paths).
 *
 * Ordering contract: `registry.trackValue()` and `registry.trackField()` are
 * called BEFORE the value touches the page, so no snapshot/network read can
 * race ahead of redaction.
 */
export async function injectSecret(
  page: Page,
  target: FillTarget,
  secret: ExportedSecret,
  registry: RedactionRegistry,
): Promise<void> {
  registry.trackValue(secret.value, secret.ref.secretId);
  registry.trackField(target.elementUid, secret.ref.secretId);
  try {
    // TODO(scaffold): resolve target.elementUid → DOM node, focus it,
    // CDP send Input.insertText { text: secret.value }, verify the field
    // accepted input (length only — never echo the value), and dispatch
    // input/change events for framework-controlled forms.
    throw new Error("not_implemented: injectSecret");
  } finally {
    secret.release();
  }
}
