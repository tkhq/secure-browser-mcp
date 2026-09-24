import type { Browser, CDPSession, ElementHandle, Page } from "puppeteer-core";

import type { BrowserHost } from "./hosts.js";

/** A snapshot-resolved element the broker can act on. */
export type ResolvedElement = {
  uid: string;
  backendNodeId: number;
  handle: ElementHandle<Element>;
};

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

  constructor(private readonly host: BrowserHost) {}

  async ensureStarted(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    // Release whatever the host still holds (a closed page, or a remote
    // session that dropped) before starting fresh.
    await this.host.stop();
    this.browser = await this.host.start();

    // A remote browser can end on its own (session timeout, network). Drop
    // the page so the next call starts a fresh session instead of failing.
    this.browser.on("disconnected", () => {
      this.clearElements();
      this.page = undefined;
      this.cdp = undefined;
      this.browser = undefined;
    });

    const pages = await this.browser.pages();
    this.page = pages[0] ?? (await this.browser.newPage());
    this.cdp = await this.page.createCDPSession();
    // Element uids are backendNodeId-based and die with the document.
    this.page.on("framenavigated", (frame) => {
      if (frame === this.page?.mainFrame()) this.clearElements();
    });
    return this.page;
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

  clearElements(): void {
    for (const e of this.elements.values()) void e.handle.dispose();
    this.elements.clear();
  }

  async close(): Promise<void> {
    this.clearElements();
    await this.host.stop();
    this.browser = undefined;
    this.page = undefined;
    this.cdp = undefined;
  }
}
