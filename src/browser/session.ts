import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer, {
  type Browser,
  type CDPSession,
  type ElementHandle,
  type Page,
} from "puppeteer-core";

export type BrowserSessionConfig = {
  /** Path to a Chrome/Chromium executable. */
  executablePath: string;
  headless?: boolean;
};

/** A snapshot-resolved element the broker can act on. */
export type ResolvedElement = {
  uid: string;
  backendNodeId: number;
  handle: ElementHandle<Element>;
};

/**
 * Owns the browser exclusively. The security model requires that nothing
 * else can reach this browser: fresh profile, no extensions, and the CDP
 * endpoint bound so only this process can connect. If another debugger can
 * attach, the redaction layer is theater.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private cdp: CDPSession | undefined;
  private elements = new Map<string, ResolvedElement>();

  constructor(private readonly config: BrowserSessionConfig) {}

  async ensureStarted(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    const userDataDir = await mkdtemp(join(tmpdir(), "sbm-profile-"));
    this.browser = await puppeteer.launch({
      executablePath: this.config.executablePath,
      headless: this.config.headless ?? true,
      // pipe:true = --remote-debugging-pipe. No TCP debugging port exists,
      // so nothing else on the host can attach a debugger to this browser.
      pipe: true,
      // Fill the window instead of puppeteer's fixed 800x600 emulation —
      // headed demos otherwise render in a letterboxed region.
      defaultViewport: null,
      userDataDir,
      args: [
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
      ],
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
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
    this.cdp = undefined;
  }
}
