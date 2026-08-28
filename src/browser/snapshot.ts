import type { ElementHandle } from "puppeteer-core";

import type { RedactionRegistry } from "../redaction/registry.js";
import type { BrowserSession, ResolvedElement } from "./session.js";

/** Agent-visible description of one interactive element. */
export type SnapshotElement = {
  uid: string;
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  label?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
};

export type PageSnapshot = {
  url: string;
  title: string;
  elements: SnapshotElement[];
};

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input",
  "select",
  "textarea",
  "[role=button]",
  "[role=link]",
  "[role=textbox]",
  "[role=checkbox]",
  "[contenteditable=true]",
].join(", ");

type RawInfo = {
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  label?: string;
  text?: string;
  value?: string;
  isPassword: boolean;
  disabled: boolean;
  visible: boolean;
};

/**
 * Capture the interactive elements of the page and register them with the
 * session so uids resolve back to live nodes. Uids are derived from CDP
 * backendNodeIds, so a field keeps its uid across snapshots of the same
 * document — which is what lets `RedactionRegistry.trackField` tags survive
 * re-snapshotting.
 *
 * Structural redaction happens HERE, not in scrub(): tagged fields and
 * password inputs never put their value into the result at all.
 */
export async function captureSnapshot(
  session: BrowserSession,
  registry: RedactionRegistry,
): Promise<PageSnapshot> {
  const page = await session.ensureStarted();

  const handles = await page.$$(INTERACTIVE_SELECTOR);
  const resolved: ResolvedElement[] = [];
  const elements: SnapshotElement[] = [];

  for (const handle of handles) {
    const info = await describeElement(handle);
    if (!info.visible) {
      void handle.dispose();
      continue;
    }
    // backendNodeIds are stable per node for the life of the document, so a
    // field keeps its uid across snapshots — and they are valid across CDP
    // sessions, unlike objectIds.
    const backendNodeId = await handle.backendNodeId();
    const uid = `e${backendNodeId}`;
    resolved.push({ uid, backendNodeId, handle });

    const el: SnapshotElement = { uid, tag: info.tag };
    if (info.role) el.role = info.role;
    if (info.type) el.type = info.type;
    if (info.name) el.name = info.name;
    if (info.label) el.label = info.label;
    if (info.text) el.text = info.text;
    if (info.disabled) el.disabled = true;
    if (info.value !== undefined) {
      if (registry.isTaggedField(uid)) {
        el.value = "[REDACTED:secret-filled-field]";
      } else if (info.isPassword) {
        // Password values are never echoed, filled or not.
        el.value = info.value.length === 0 ? "" : "[MASKED:password-field]";
      } else {
        el.value = info.value;
      }
    }
    elements.push(el);
  }

  session.setElements(resolved);
  return { url: page.url(), title: await page.title(), elements };
}

function describeElement(handle: ElementHandle<Element>): Promise<RawInfo> {
  return handle.evaluate((el) => {
    const input = el as HTMLInputElement;
    const rect = el.getBoundingClientRect();
    const labelText =
      (input.labels && input.labels[0]?.textContent) ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      undefined;
    const isPassword =
      el.tagName === "INPUT" && input.type?.toLowerCase() === "password";
    const info: {
      tag: string;
      role?: string;
      type?: string;
      name?: string;
      label?: string;
      text?: string;
      value?: string;
      isPassword: boolean;
      disabled: boolean;
      visible: boolean;
    } = {
      tag: el.tagName.toLowerCase(),
      isPassword,
      disabled: input.disabled === true,
      visible: rect.width > 0 && rect.height > 0,
    };
    const role = el.getAttribute("role");
    if (role) info.role = role;
    if (el.tagName === "INPUT" && input.type) info.type = input.type;
    const name = el.getAttribute("name") ?? el.getAttribute("id");
    if (name) info.name = name;
    if (labelText) info.label = labelText.trim();
    const text = (el as HTMLElement).innerText?.trim().slice(0, 120);
    if (text && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      info.text = text;
    }
    if ("value" in el && typeof input.value === "string") {
      info.value = input.value;
    }
    return info;
  });
}
