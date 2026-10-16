/**
 * Builds the `TargetObservation` that @turnkey/browser-secrets `authorize`
 * decides on. `authorize` trusts the observation as given, so every fact
 * here comes from the browser over the broker's own CDP session, where page
 * script cannot change it:
 *
 *  - frame and document identity, URL and effective origin come from
 *    `Page.getFrameTree` (browser-side state, not page JS);
 *  - shadow-root mode and selector matches are evaluated in an isolated
 *    world, so a page that overrides `Element.prototype.matches` or
 *    `getRootNode` in its own world changes nothing here.
 *
 * Snapshots list elements of the top-level document only (`page.$$` on the
 * main frame), so every target's frame ancestry is that one document. An
 * element outside it, or one that is detached, is left out of the
 * observation, and `authorize` refuses it as `target_not_observed`.
 */
import {
  requiredSelectors,
  type FillRequest,
  type ObservedDocument,
  type ObservedTarget,
  type RedactionTarget,
  type SecretRef,
  type ShadowRootMode,
  type TargetObservation,
} from "@turnkey/browser-secrets";
import type { CDPSession } from "puppeteer-core";

import type { BrowserSession } from "./session.js";

/** Isolated world the broker reads element facts in. */
const WORLD_NAME = "sbm-observe";

/**
 * Runs with `this` bound to the element, in the isolated world. Returns
 * null for a detached element. A selector the browser rejects records
 * false, as browser-secrets requires.
 */
const INSPECT_ELEMENT = `function (selectors) {
  if (!this.isConnected) return null;
  let shadowRoot = "none";
  for (let root = this.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    if (root.mode === "closed") { shadowRoot = "closed"; break; }
    shadowRoot = "open";
  }
  const matches = selectors.map((selector) => {
    try { return Element.prototype.matches.call(this, selector) === true; }
    catch { return false; }
  });
  return { shadowRoot, matches };
}`;

type InspectResult = { shadowRoot: ShadowRootMode; matches: boolean[] } | null;

/** The live top-level document and the tab that shows it. */
export type TopLevelDocument = {
  browserSessionId: string;
  tabId: string;
  document: ObservedDocument;
};

/**
 * Reads the top-level document's identity from the browser. The frame ID of
 * a tab's main frame is its target ID, so it doubles as the tab identity.
 * The loader ID changes with every new document in the frame, and is the
 * document identity.
 */
export async function topLevelDocument(
  session: BrowserSession,
): Promise<TopLevelDocument> {
  await session.ensureStarted();
  const cdp = session.cdpSession();
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const frame = frameTree.frame;
  return {
    browserSessionId: session.sessionId(),
    tabId: frame.id,
    document: {
      frameId: frame.id,
      documentId: frame.loaderId,
      url: frame.url + (frame.urlFragment ?? ""),
      // Chrome reports an opaque origin as "null"; an empty one (a frame
      // with no document yet) is treated the same.
      origin: frame.securityOrigin || "null",
    },
  };
}

/** The redaction identity of a snapshot element in the top-level document. */
export function redactionTarget(
  top: TopLevelDocument,
  elementId: string,
): RedactionTarget {
  return {
    browserSessionId: top.browserSessionId,
    tabId: top.tabId,
    frameId: top.document.frameId,
    documentId: top.document.documentId,
    elementId,
  };
}

/**
 * Observes every element `request` names, evaluating the selectors the
 * secret's binding requires for it (`requiredSelectors`). Each element is
 * observed once, even when the request names it under several keys, so
 * element IDs are unique across the observation.
 */
export async function observeTargets(
  session: BrowserSession,
  ref: Pick<SecretRef, "staticProperties">,
  request: FillRequest,
): Promise<TargetObservation> {
  const page = await session.ensureStarted();
  const cdp = session.cdpSession();
  const top = await topLevelDocument(session);

  const selectors = new Map<string, Set<string>>();
  for (const target of request.targets) {
    if (!selectors.has(target.elementId)) {
      selectors.set(target.elementId, new Set());
    }
  }
  for (const { elementId, selector } of requiredSelectors(ref, request)) {
    if (selector !== undefined) selectors.get(elementId)?.add(selector);
  }

  // Enable the DOM agent on the broker's session so backendNodeIds resolve.
  await cdp.send("DOM.getDocument", { depth: 0 });
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: top.document.frameId,
    worldName: WORLD_NAME,
  });

  const targets: ObservedTarget[] = [];
  for (const [elementId, wanted] of selectors) {
    let element;
    try {
      element = session.resolveElement(elementId);
    } catch {
      continue; // Unknown or stale uid: not observed.
    }
    if (element.handle.frame !== page.mainFrame()) continue;
    const list = [...wanted];
    const facts = await inspect(
      cdp,
      element.backendNodeId,
      executionContextId,
      list,
    );
    if (!facts) continue;
    const selectorMatches: Record<string, boolean> = {};
    list.forEach((selector, i) => {
      Object.defineProperty(selectorMatches, selector, {
        value: facts.matches[i] === true,
        enumerable: true,
      });
    });
    targets.push({
      elementId,
      frames: [top.document],
      shadowRoot: facts.shadowRoot,
      selectorMatches,
    });
  }

  return {
    browserSessionId: top.browserSessionId,
    tabId: top.tabId,
    topLevelUrl: top.document.url,
    targets,
  };
}

/** Element facts from the isolated world, or null when it cannot be read. */
async function inspect(
  cdp: CDPSession,
  backendNodeId: number,
  executionContextId: number,
  selectors: string[],
): Promise<InspectResult> {
  let objectId: string | undefined;
  try {
    // Fails when the node is gone or is not in this frame's document.
    ({
      object: { objectId },
    } = await cdp.send("DOM.resolveNode", {
      backendNodeId,
      executionContextId,
    }));
    if (!objectId) return null;
    const { result, exceptionDetails } = await cdp.send(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: INSPECT_ELEMENT,
        arguments: [{ value: selectors }],
        returnByValue: true,
      },
    );
    if (exceptionDetails) return null;
    return (result.value ?? null) as InspectResult;
  } catch {
    return null;
  } finally {
    if (objectId) {
      void cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }
}
