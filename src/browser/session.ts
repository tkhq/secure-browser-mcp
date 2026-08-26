import type { Browser, Page } from "puppeteer-core";

export type BrowserSessionConfig = {
  /** Path to a Chrome/Chromium executable. */
  executablePath: string;
  headless?: boolean;
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

  constructor(private readonly config: BrowserSessionConfig) {}

  async ensureStarted(): Promise<Page> {
    // TODO(scaffold): puppeteer-core launch with
    //   --user-data-dir=<fresh tmp dir>, --disable-extensions,
    //   --remote-debugging-pipe (no TCP debugging port),
    //   headless per config; single page; navigation event wiring.
    throw new Error("not_implemented: BrowserSession.ensureStarted");
  }

  currentPage(): Page | undefined {
    return this.page;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
    this.page = undefined;
  }
}
