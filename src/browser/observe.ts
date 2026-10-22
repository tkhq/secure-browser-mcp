/**
 * Builds the `TargetObservation` that @turnkey/browser-secrets `authorize`
 * decides on. `authorize` trusts the observation as given, so every fact
 * here comes from the browser over the broker's own CDP sessions, where
 * page script cannot change it:
 *
 *  - frame and document identity and URL come from `Page.getFrameTree`
 *    (browser-side state, not page JS), in the session of the target that
 *    hosts the frame: the tab, or an out-of-process iframe;
 *  - the effective origin is the frame tree's `securityOrigin`, kept only
 *    when `window.origin` in an isolated world agrees, and `"null"`
 *    (opaque) otherwise;
 *  - shadow-root mode and selector matches are evaluated in an isolated
 *    world, so a page that overrides `Element.prototype.matches` or
 *    `getRootNode` in its own world changes nothing here.
 *
 * A target's frame ancestry runs from the top-level document to the
 * element's own document, one entry for each frame. An element whose
 * ancestry cannot be read, whose document is not the one it was
 * snapshotted in, or that is detached, is left out of the observation, and
 * `authorize` refuses it as `target_not_observed`.
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
import type { CDPSession, Frame } from "puppeteer-core";

import {
  findFrameNode,
  type BrowserSession,
  type FrameLocation,
} from "./session.js";

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

/** A frame's live document, and where the broker reads it. */
export type FrameDocument = {
  /** The broker's session for the target that hosts the frame. */
  cdp: CDPSession;
  /** The broker's isolated world in the document. */
  executionContextId: number;
  document: ObservedDocument;
};

/** Frame lookups shared by the reads of one snapshot or observation. */
export type FrameCache = {
  locations: Map<Frame, Promise<FrameLocation | null>>;
  documents: Map<Frame, Promise<FrameDocument | null>>;
};

export function frameCache(): FrameCache {
  return { locations: new Map(), documents: new Map() };
}

/**
 * Reads the live document of `frame` from the browser. The loader ID
 * changes with every new document in the frame, and is the document
 * identity. Returns null for a frame the broker cannot place.
 */
export function frameDocument(
  session: BrowserSession,
  frame: Frame,
  cache: FrameCache = frameCache(),
): Promise<FrameDocument | null> {
  let found = cache.documents.get(frame);
  if (!found) {
    found = readFrameDocument(session, frame, cache).catch(() => null);
    cache.documents.set(frame, found);
  }
  return found;
}

async function readFrameDocument(
  session: BrowserSession,
  frame: Frame,
  cache: FrameCache,
): Promise<FrameDocument | null> {
  const located = await session.locateFrame(frame, cache.locations);
  if (!located) return null;
  const { cdp, frameId } = located;
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const node = findFrameNode(frameTree, frameId)?.frame;
  if (!node) return null;
  // Enable the DOM agent on the broker's session so backendNodeIds resolve.
  await cdp.send("DOM.getDocument", { depth: 0 });
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId,
    worldName: WORLD_NAME,
  });
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: "window.origin",
    contextId: executionContextId,
    returnByValue: true,
  });
  // Chrome reports an opaque origin as "null", and an empty one (a frame
  // with no document yet) is treated the same. A sandboxed frame can report
  // the origin of its URL in the frame tree while its document's origin is
  // opaque; any disagreement counts as opaque.
  const reported = node.securityOrigin || "null";
  return {
    cdp,
    executionContextId,
    document: {
      frameId,
      documentId: node.loaderId,
      url: node.url + (node.urlFragment ?? ""),
      origin: result.value === reported ? reported : "null",
    },
  };
}

/**
 * Reads the top-level document's identity from the browser. The frame ID of
 * a tab's main frame is its target ID, so it doubles as the tab identity.
 */
export async function topLevelDocument(
  session: BrowserSession,
  cache?: FrameCache,
): Promise<TopLevelDocument> {
  const page = await session.ensureStarted();
  const top = await frameDocument(session, page.mainFrame(), cache);
  if (!top) throw new Error("The page has no readable document");
  return {
    browserSessionId: session.sessionId(),
    tabId: top.document.frameId,
    document: top.document,
  };
}

/**
 * The documents from the top-level document down to `frame`'s, or null
 * when one of them cannot be read.
 */
async function frameAncestry(
  session: BrowserSession,
  frame: Frame,
  cache: FrameCache,
): Promise<FrameDocument[] | null> {
  const chain: FrameDocument[] = [];
  for (let f: Frame | null = frame; f; f = f.parentFrame()) {
    const doc = await frameDocument(session, f, cache);
    if (!doc) return null;
    chain.unshift(doc);
  }
  return chain;
}

/** The redaction identity of a snapshot element in `document`. */
export function redactionTarget(
  top: TopLevelDocument,
  document: Pick<ObservedDocument, "frameId" | "documentId">,
  elementId: string,
): RedactionTarget {
  return {
    browserSessionId: top.browserSessionId,
    tabId: top.tabId,
    frameId: document.frameId,
    documentId: document.documentId,
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
  const cache = frameCache();
  const top = await topLevelDocument(session, cache);

  const selectors = new Map<string, Set<string>>();
  for (const target of request.targets) {
    if (!selectors.has(target.elementId)) {
      selectors.set(target.elementId, new Set());
    }
  }
  for (const { elementId, selector } of requiredSelectors(ref, request)) {
    if (selector !== undefined) selectors.get(elementId)?.add(selector);
  }

  const targets: ObservedTarget[] = [];
  for (const [elementId, wanted] of selectors) {
    let element;
    try {
      element = session.resolveElement(elementId);
    } catch {
      continue; // Unknown or stale uid: not observed.
    }
    const frames = await frameAncestry(session, element.handle.frame, cache);
    if (!frames) continue;
    const doc = frames[frames.length - 1]!;
    // The ancestry starts at the top-level document reported below, and
    // ends at the document the element was snapshotted in, in the session
    // of the target that holds it.
    if (
      frames[0]!.document.documentId !== top.document.documentId ||
      doc.cdp !== element.cdp ||
      doc.document.frameId !== element.frameId ||
      doc.document.documentId !== element.documentId
    ) {
      continue;
    }
    const list = [...wanted];
    const facts = await inspect(
      doc.cdp,
      element.backendNodeId,
      doc.executionContextId,
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
      frames: frames.map((f) => f.document),
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
