import { randomUUID } from "node:crypto";

import type {
  Browser,
  CDPSession,
  ElementHandle,
  Frame,
  Page,
  Protocol,
} from "puppeteer-core";

import type { BrowserHost } from "./hosts.js";

/** A snapshot-resolved element the broker can act on. */
export type ResolvedElement = {
  uid: string;
  backendNodeId: number;
  handle: ElementHandle<Element>;
  /**
   * The broker's CDP session for the target that holds the element: the
   * tab, or an out-of-process iframe. A backendNodeId means something only
   * in its own target, so every CDP call for the element goes here.
   */
  cdp: CDPSession;
  /** The element's frame and the document it was snapshotted in. */
  frameId: string;
  documentId: string;
};

/** Where a frame's document lives: its frame ID and the session that hosts it. */
export type FrameLocation = { cdp: CDPSession; frameId: string };

/**
 * Owns the browser exclusively. The security model requires that nothing
 * else can reach this browser: fresh profile, no extensions, and a CDP
 * channel only this process holds. If another debugger can attach, the
 * redaction layer is theater. Where the browser runs is the host's job
 * (src/browser/hosts.ts); what counts as "nothing else" depends on the host.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  private elements = new Map<string, ResolvedElement>();
  private browserSessionId = randomUUID();
  /** Broker sessions to out-of-process iframes, by target ID (= frame ID). */
  private frameSessions = new Map<string, CDPSession>();
  /** A short tag for each of those sessions, for element uids. */
  private sessionTags = new WeakMap<CDPSession, string>();
  private nextSessionTag = 1;

  constructor(private readonly host: BrowserHost) {}

  /**
   * Host-owned identity of the running browser, for browser-secrets
   * observations and redaction targets. Each browser start gets a new one,
   * so nothing recorded against an earlier browser matches the new one.
   */
  sessionId(): string {
    return this.browserSessionId;
  }

  async ensureStarted(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    // Release whatever the host still holds (a closed page, or a remote
    // session that dropped) before starting fresh.
    await this.host.stop();
    this.browser = await this.host.start();
    this.browserSessionId = randomUUID();

    // A remote browser can end on its own (session timeout, network). Drop
    // the page so the next call starts a fresh session instead of failing.
    this.browser.on("disconnected", () => {
      this.clearElements();
      this.frameSessions.clear();
      this.page = undefined;
      this.cdp = undefined;
      this.browser = undefined;
    });

    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    this.cdp = await this.page.createCDPSession();
    this.frameSessions.clear();
    // A host that cannot auto-attach still works for the top-level target:
    // out-of-process iframes are then left out of snapshots, never guessed.
    await this.attachFrames(this.cdp).catch(() => {});
    // Element uids are backendNodeId-based and die with the document. A
    // frame that navigates or goes away takes its elements, and those of
    // the frames inside it, with it.
    const invalidate = (frame: Frame) => {
      if (frame === this.page?.mainFrame()) return this.clearElements();
      this.dropElements((e) => isWithin(e.handle.frame, frame));
    };
    this.page.on("framenavigated", invalidate);
    this.page.on("framedetached", invalidate);
    return this.page;
  }

  /**
   * Attach the broker's own flattened sessions to the out-of-process
   * iframes of `parent`'s target, and to theirs in turn. Chrome attaches
   * existing iframes at once and new ones as they appear. The same calls
   * work over a local pipe and over a remote CDP WebSocket.
   */
  private async attachFrames(parent: CDPSession): Promise<void> {
    parent.on("Target.attachedToTarget", (event) => {
      const { sessionId, targetInfo } = event;
      if (targetInfo.type !== "iframe") return;
      const child = parent.connection()?.session(sessionId);
      if (!child) return;
      this.frameSessions.set(targetInfo.targetId, child);
      this.sessionTags.set(child, `f${this.nextSessionTag++}`);
      void this.attachFrames(child).catch(() => {});
    });
    parent.on("Target.detachedFromTarget", (event) => {
      for (const [id, child] of this.frameSessions) {
        if (child.id() !== event.sessionId) continue;
        this.frameSessions.delete(id);
        this.dropElements((e) => e.cdp === child);
      }
    });
    await parent.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe" }, { exclude: true }],
    });
  }

  /**
   * Finds the document of `frame` from the browser, using puppeteer's frame
   * tree for structure only: the frame ID comes from the owner `<iframe>`
   * node in the parent's target, and the frame must be listed in the frame
   * tree of the session said to host it. Returns null for a frame the
   * broker cannot place (detached, or its owner is not reachable, as for
   * an iframe inside a shadow root). Such a frame is left out of snapshots.
   */
  async locateFrame(
    frame: Frame,
    cache = new Map<Frame, Promise<FrameLocation | null>>(),
  ): Promise<FrameLocation | null> {
    let found = cache.get(frame);
    if (!found) {
      found = this.findFrame(frame, cache).catch(() => null);
      cache.set(frame, found);
    }
    return found;
  }

  private async findFrame(
    frame: Frame,
    cache: Map<Frame, Promise<FrameLocation | null>>,
  ): Promise<FrameLocation | null> {
    const page = await this.ensureStarted();
    const cdp = this.cdpSession();
    if (frame.detached) return null;
    if (frame === page.mainFrame()) {
      const { frameTree } = await cdp.send("Page.getFrameTree");
      return { cdp, frameId: frameTree.frame.id };
    }
    const parent = frame.parentFrame();
    if (!parent) return null;
    const host = await this.locateFrame(parent, cache);
    if (!host) return null;
    const owner = await frame.frameElement();
    if (!owner) return null;
    let frameId: string | undefined;
    try {
      // The owner node lives in the parent's target, so its backendNodeId
      // is looked up there.
      await host.cdp.send("DOM.getDocument", { depth: 0 });
      ({
        node: { frameId },
      } = await host.cdp.send("DOM.describeNode", {
        backendNodeId: await owner.backendNodeId(),
      }));
    } finally {
      void owner.dispose();
    }
    if (!frameId) return null;
    // An out-of-process iframe is its own target, whose ID is the frame ID.
    const child = this.frameSessions.get(frameId);
    const located = { cdp: child ?? host.cdp, frameId };
    const { frameTree } = await located.cdp.send("Page.getFrameTree");
    const node = findFrameNode(frameTree, frameId);
    if (!node) return null;
    if (child === undefined && node.frame.parentId !== host.frameId) {
      return null;
    }
    return located;
  }

  /**
   * The uid for a node: its backendNodeId, prefixed for a node in an
   * out-of-process iframe, whose target numbers its nodes on its own.
   */
  elementUid(cdp: CDPSession, backendNodeId: number): string {
    const tag = cdp === this.cdp ? "" : (this.sessionTags.get(cdp) ?? "f0");
    return `${tag}e${backendNodeId}`;
  }

  /** Whether a browser is running, so the session holds one. */
  isStarted(): boolean {
    return this.page !== undefined && !this.page.isClosed();
  }

  currentPage(): Page | undefined {
    return this.page;
  }

  /** The broker's own CDP channel (used for DOM.focus / Input.insertText). */
  cdpSession(): CDPSession {
    if (!this.cdp) throw new Error("Browser not started");
    return this.cdp;
  }

  /** Replace the uid → element registry (called by each snapshot). */
  setElements(elements: ResolvedElement[]): void {
    this.clearElements();
    for (const e of elements) this.elements.set(e.uid, e);
  }

  /** Whether a snapshot uid is known (it may still be detached). */
  hasElement(uid: string): boolean {
    return this.elements.has(uid);
  }

  /**
   * Resolve a snapshot uid to a live element. Throws if the uid is unknown
   * or stale — callers surface "take a new snapshot" to the agent.
   */
  resolveElement(uid: string): ResolvedElement {
    const el = this.elements.get(uid);
    if (!el) {
      throw new Error(
        `Unknown element uid "${uid}". Take a snapshot first; uids are ` +
          `invalidated by navigation.`,
      );
    }
    return el;
  }

  private dropElements(match: (e: ResolvedElement) => boolean): void {
    for (const [uid, e] of this.elements) {
      if (!match(e)) continue;
      void e.handle.dispose();
      this.elements.delete(uid);
    }
  }

  clearElements(): void {
    for (const e of this.elements.values()) void e.handle.dispose();
    this.elements.clear();
  }

  async close(): Promise<void> {
    this.clearElements();
    this.frameSessions.clear();
    await this.host.stop();
    this.browser = undefined;
    this.page = undefined;
    this.cdp = undefined;
  }
}

/** Whether `frame` is `ancestor` or inside it. A detached frame counts. */
function isWithin(frame: Frame, ancestor: Frame): boolean {
  if (frame.detached) return true;
  for (let f: Frame | null = frame; f; f = f.parentFrame()) {
    if (f === ancestor) return true;
  }
  return false;
}

export function findFrameNode(
  tree: Protocol.Page.FrameTree,
  frameId: string,
): Protocol.Page.FrameTree | undefined {
  if (tree.frame.id === frameId) return tree;
  for (const child of tree.childFrames ?? []) {
    const found = findFrameNode(child, frameId);
    if (found) return found;
  }
  return undefined;
}
