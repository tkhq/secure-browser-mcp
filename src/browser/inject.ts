import type { ExportedSecret } from "../broker/types.js";
import type { BrowserSession } from "./session.js";

/**
 * The one function that handles plaintext: focuses the bound element and
 * types the secret via CDP `Input.insertText` (raw CDP, not page JS — the
 * value must never transit `Runtime.evaluate`, whose expressions end up in
 * agent-visible tool code paths).
 *
 * Ordering contract: the caller registers the value and the target with
 * the redaction registry BEFORE calling this, so no snapshot/network read
 * can race ahead of redaction (see `injectResolved` in
 * src/tools/fill-common.ts).
 */
export async function injectSecret(
  session: BrowserSession,
  elementUid: string,
  secret: ExportedSecret,
): Promise<void> {
  try {
    const element = session.resolveElement(elementUid);
    // The session of the target that holds the element: the tab, or an
    // out-of-process iframe. The element's backendNodeId means nothing in
    // any other target, and Input.insertText types into that target's
    // focused element.
    const cdp = element.cdp;

    // Clear any stale content, then focus via CDP and insert the plaintext.
    // Input.insertText behaves like an IME commit: it fires the native
    // beforeinput/input events, so framework-controlled forms see the value.
    await element.handle.evaluate((el) => {
      const input = el as HTMLInputElement;
      if ("value" in el) input.value = "";
    });
    // Enable the DOM agent on that session so backendNodeId resolves.
    await cdp.send("DOM.getDocument", { depth: 0 });
    await cdp.send("DOM.focus", { backendNodeId: element.backendNodeId });
    await cdp.send("Input.insertText", { text: secret.value });

    // Verify acceptance by length only — never echo the value. The field may
    // hold MORE characters than we inserted (auto-formatters add separators:
    // "4242424242424242" renders as "4242 4242 4242 4242"), so only an empty
    // or clearly truncated field is a failure.
    const acceptedLength = await element.handle.evaluate((el) => {
      const input = el as HTMLInputElement;
      return "value" in el ? input.value.length : -1;
    });
    if (acceptedLength >= 0 && acceptedLength < secret.value.length) {
      throw new Error(
        `Fill verification failed: field holds ${acceptedLength} chars, ` +
          `expected at least ${secret.value.length}`,
      );
    }
    // Commit for frameworks listening on change/blur.
    await element.handle.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  } finally {
    secret.release();
  }
}
