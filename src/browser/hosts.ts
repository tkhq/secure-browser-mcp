/**
 * Where the broker's browser runs. `BrowserSession` asks a host for a
 * connected browser and hands it back on close; everything above it (CDP
 * injection, snapshots, tools) is the same for every host.
 *
 *  - `LocalChromeHost`: Chrome on this machine, driven over a pipe. No TCP
 *    debugging port exists, so nothing else on the host can attach. The
 *    stdio broker uses it.
 *  - `BrowserbaseHost`: a Browserbase session reached over its CDP
 *    WebSocket. The browser runs on Browserbase, so Browserbase can see
 *    secret plaintext during a fill (docs/THREAT-MODEL.md, "Hosted broker").
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer, { type Browser } from "puppeteer-core";

export interface BrowserHost {
  readonly kind: "local" | "browserbase";
  /** Start a fresh browser for one agent session. */
  start(): Promise<Browser>;
  /** Tear the browser down; safe to call when nothing is running. */
  stop(): Promise<void>;
}

export type LocalChromeConfig = {
  /** Path to a Chrome/Chromium executable. */
  executablePath: string;
  headless?: boolean;
  /** Extra Chrome flags from the deployment (SBM_CHROME_ARGS). */
  extraArgs?: string[];
};

export class LocalChromeHost implements BrowserHost {
  readonly kind = "local";
  private browser: Browser | undefined;
  private userDataDir: string | undefined;

  constructor(private readonly config: LocalChromeConfig) {}

  async start(): Promise<Browser> {
    this.userDataDir = await mkdtemp(join(tmpdir(), "sbm-profile-"));
    this.browser = await puppeteer.launch({
      executablePath: this.config.executablePath,
      headless: this.config.headless ?? true,
      // pipe:true = --remote-debugging-pipe. No TCP debugging port exists,
      // so nothing else on the host can attach a debugger to this browser.
      pipe: true,
      // Fill the window instead of puppeteer's fixed 800x600 emulation —
      // headed demos otherwise render in a letterboxed region.
      defaultViewport: null,
      userDataDir: this.userDataDir,
      args: [
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        ...(this.config.extraArgs ?? []),
      ],
    });
    return this.browser;
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
    if (this.userDataDir) {
      await rm(this.userDataDir, { recursive: true, force: true });
      this.userDataDir = undefined;
    }
  }
}

export type BrowserbaseConfig = {
  apiKey: string;
  /** Defaults to the first project the key can see. */
  projectId?: string;
  /** Session lifetime cap in seconds (Browserbase `timeout`). */
  timeoutSeconds?: number;
  apiBaseUrl?: string;
};

const BROWSERBASE_API = "https://api.browserbase.com/v1";

export class BrowserbaseHost implements BrowserHost {
  readonly kind = "browserbase";
  private browser: Browser | undefined;
  private sessionId: string | undefined;
  private projectId: string | undefined;

  constructor(private readonly config: BrowserbaseConfig) {
    this.projectId = config.projectId;
  }

  async start(): Promise<Browser> {
    this.projectId ??= await this.firstProject();
    // Recording and session logs would store the page, including filled
    // fields, on Browserbase. They stay off for every broker session.
    const session = (await this.api("POST", "/sessions", {
      projectId: this.projectId,
      keepAlive: false,
      ...(this.config.timeoutSeconds
        ? { timeout: this.config.timeoutSeconds }
        : {}),
      browserSettings: { recordSession: false, logSession: false },
      userMetadata: { purpose: "secure-browser-mcp" },
    })) as { id: string; connectUrl: string };
    this.sessionId = session.id;
    // connectUrl carries a session credential: never log or return it.
    try {
      this.browser = await puppeteer.connect({
        browserWSEndpoint: session.connectUrl,
        defaultViewport: null,
      });
    } catch (err) {
      await this.stop();
      throw err;
    }
    return this.browser;
  }

  async stop(): Promise<void> {
    await this.browser?.disconnect().catch(() => {});
    this.browser = undefined;
    const id = this.sessionId;
    this.sessionId = undefined;
    if (id) {
      await this.api("POST", `/sessions/${encodeURIComponent(id)}`, {
        projectId: this.projectId,
        status: "REQUEST_RELEASE",
      }).catch((err) =>
        console.error(
          `secure-browser-mcp: Browserbase session ${id} not released: ${err}`,
        ),
      );
    }
  }

  private async firstProject(): Promise<string> {
    const projects = (await this.api("GET", "/projects")) as { id: string }[];
    const id = projects[0]?.id;
    if (!id) throw new Error("Browserbase API key has no projects");
    return id;
  }

  private async api(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(
      `${this.config.apiBaseUrl ?? BROWSERBASE_API}${path}`,
      {
        method,
        headers: {
          "X-BB-API-Key": this.config.apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!res.ok) {
      // Status only: response bodies can echo request details.
      throw new Error(`Browserbase ${method} ${path} failed: ${res.status}`);
    }
    return res.json();
  }
}
