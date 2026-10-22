import type { CDPSession } from "puppeteer-core";

import type { ExportedSecret } from "../broker/types.js";
import type { BrowserSession } from "./session.js";

/**
 * Non-secret facts about a field after a fill, so the agent can tell a fill
 * the page kept from one it dropped. Never the value or any part of it.
 */
export type FieldCheck = {
  /** Length of the field's current value; absent when the field could not
   * be read back (the page removed it). */
  length?: number;
  /** Whether the current value equals the secret, ignoring spaces and
   * punctuation the page may add (a card number grouped in fours). */
  matches: boolean;
  /** The field's `validity.valid`, for elements that have one. */
  valid?: boolean;
};

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
 *
 * Returns what the field holds after the write (see `FieldCheck`). A page
 * that drops or rewrites the value is reported, not treated as an error.
 */
export async function injectSecret(
  session: BrowserSession,
  elementUid: string,
  secret: ExportedSecret,
): Promise<FieldCheck> {
  try {
    const element = session.resolveElement(elementUid);
    const cdp = session.cdpSession();

    // Clear any stale content, then focus via CDP and insert the plaintext.
    // Input.insertText behaves like an IME commit: it fires the native
    // beforeinput/input events, so framework-controlled forms see the value.
    await element.handle.evaluate((el) => {
      const input = el as HTMLInputElement;
      if ("value" in el) input.value = "";
    });
    // Enable the DOM agent on the broker's session so backendNodeId resolves.
    await cdp.send("DOM.getDocument", { depth: 0 });
    await cdp.send("DOM.focus", { backendNodeId: element.backendNodeId });
    await cdp.send("Input.insertText", { text: secret.value });

    // Commit for frameworks listening on change/blur.
    await element.handle.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return await checkField(cdp, element.backendNodeId, secret.value);
  } finally {
    secret.release();
  }
}

/** Letters and digits only, so formatting the page adds does not count. */
const significant = (s: string) =>
  s.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "");

/** Runs with `this` bound to the field. Returns its value and validity. */
const READ_FIELD = `function () {
  const value = typeof this.value === "string" ? this.value : (this.textContent ?? "");
  const valid = this.validity && typeof this.validity.valid === "boolean" ? this.validity.valid : null;
  return { value, valid };
}`;

/**
 * Reads the field back and compares it in the broker. The value comes out
 * of the page, is compared, and is dropped here: only the facts leave this
 * function. It reads by backendNodeId over CDP, not through the element
 * handle, so it still works when the change event made the page navigate
 * within the document (which disposes the handles). The facts are only as
 * true as the page lets them be, since page script can change what a field
 * reports. A field that cannot be read back reports no length and no match.
 */
async function checkField(
  cdp: CDPSession,
  backendNodeId: number,
  secret: string,
): Promise<FieldCheck> {
  let objectId: string | undefined;
  let field: { value: string; valid: boolean | null } | undefined;
  try {
    ({
      object: { objectId },
    } = await cdp.send("DOM.resolveNode", { backendNodeId }));
    if (objectId) {
      const { result } = await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: READ_FIELD,
        returnByValue: true,
      });
      field = result.value as typeof field;
    }
  } catch {
    // The node is gone: nothing to report.
  } finally {
    if (objectId) {
      void cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
  if (typeof field?.value !== "string") return { matches: false };
  const loose = significant(secret);
  const check: FieldCheck = {
    length: field.value.length,
    matches:
      field.value === secret ||
      (loose.length > 0 && significant(field.value) === loose),
  };
  if (typeof field.valid === "boolean") check.valid = field.valid;
  return check;
}
