import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { BrowserHost } from "./hosts.js";
import { WorkerTransport } from "./lightpanda-transport.js";

/** One dedicated, externally provisioned worker. Never reconnect or reuse it. */
export class LightpandaHost implements BrowserHost {
  readonly kind = "lightpanda";
  private used = false;
  private generation = 0;
  private abort: AbortController | undefined;
  private transport: WorkerTransport | undefined;
  private browser: Browser | undefined;
  constructor(private readonly socketPath: string) {}
  async start(): Promise<Browser> {
    if (this.used)
      throw new Error("Lightpanda worker consumed; provision a fresh worker");
    this.used = true;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    try {
      this.transport = await WorkerTransport.open(this.socketPath);
      if (generation !== this.generation) throw new Error("Cancelled");
      const connecting = puppeteer
        .connect({
          transport: this.transport,
          defaultViewport: null,
          protocolTimeout: 10000,
        })
        .then(async (browser) => {
          if (abort.signal.aborted) {
            await browser.disconnect();
            throw new Error("Cancelled");
          }
          return browser;
        });
      let onAbort!: () => void;
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Cancelled"));
        abort.signal.addEventListener("abort", onAbort, { once: true });
        if (abort.signal.aborted) onAbort();
      });
      try {
        this.browser = await Promise.race([connecting, cancelled]);
      } finally {
        abort.signal.removeEventListener("abort", onAbort);
      }
      if (generation !== this.generation) throw new Error("Cancelled");
      return this.browser;
    } catch {
      await this.stop();
      throw new Error("Lightpanda worker attachment failed");
    }
  }
  async openPage(browser: Browser): Promise<Page> {
    const generation = this.generation;
    try {
      if (browser !== this.browser) throw new Error("Stale browser");
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await verifyObservationIsolation(page);
      if (generation !== this.generation) throw new Error("Cancelled");
      return page;
    } catch {
      await this.stop();
      throw new Error(
        "Lightpanda lacks required CDP observation isolation; worker closed",
      );
    }
  }
  async stop() {
    ++this.generation;
    this.abort?.abort();
    this.transport?.close();
    this.transport = undefined;
    await this.browser?.disconnect().catch(() => {});
    this.browser = undefined;
  }
}

/** A startup gate, not a substitute for conformance testing of a pinned build. */
export async function verifyObservationIsolation(page: Page) {
  const cdp = await page.createCDPSession();
  try {
    await page.goto('data:text/html,<input id="probe">');
    const {
      frameTree: { frame },
    } = await cdp.send("Page.getFrameTree");
    if (
      !frame.id ||
      !frame.loaderId ||
      !frame.url.startsWith("data:text/html,")
    )
      throw new Error("Missing document identity");
    await page.evaluate(() => {
      (globalThis as any).__sbmProbe = true;
      Element.prototype.matches = () => false;
      Element.prototype.getRootNode = () => {
        throw new Error("page override");
      };
    });
    const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
      frameId: frame.id,
      worldName: "sbm-observe",
    });
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression:
        'globalThis.__sbmProbe === undefined && document.querySelector("#probe").matches("input") && document.querySelector("#probe").getRootNode() === document',
      contextId: executionContextId,
      returnByValue: true,
    });
    if (exceptionDetails || result.value !== true)
      throw new Error("World not isolated");
    await page.goto("about:blank");
    const next = await cdp.send("Page.getFrameTree");
    if (
      !next.frameTree.frame.loaderId ||
      next.frameTree.frame.loaderId === frame.loaderId
    )
      throw new Error("Document identity reused");
  } finally {
    await cdp.detach().catch(() => {});
  }
}
