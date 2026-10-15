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
 *  - `LightpandaHost` (experimental): a Lightpanda process on this machine,
 *    one per session, reached over a CDP WebSocket on a loopback port.
 *    Lightpanda has no sandbox and its CDP port has no authentication
 *    (docs/THREAT-MODEL.md, "Lightpanda").
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer, { type Browser, type Page } from "puppeteer-core";

export interface BrowserHost {
  readonly kind: "local" | "browserbase" | "lightpanda";
  /** Start a fresh browser for one agent session. */
  start(): Promise<Browser>;
  /**
   * The page the session drives. Without this, the session uses the
   * browser's first page, or opens one.
   */
  openPage?(browser: Browser): Promise<Page>;
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

export type LightpandaConfig = {
  /** Path to the Lightpanda executable. */
  executablePath: string;
  /** Extra `lightpanda serve` flags from the deployment (SBM_LIGHTPANDA_ARGS). */
  extraArgs?: string[];
  /** How long to wait for the CDP server to accept connections. */
  startTimeoutMs?: number;
};

/**
 * Experimental. One `lightpanda serve` process per session, on a random
 * loopback port. Lightpanda serves CDP over TCP without authentication, so
 * any process on this host that finds the port can attach while the
 * session runs: run the broker where nothing else does.
 */
export class LightpandaHost implements BrowserHost {
  readonly kind = "lightpanda";
  private browser: Browser | undefined;
  private process: ChildProcess | undefined;
  /** Settles when the process is gone: it exited, or it never started. */
  private exited: Promise<string> | undefined;

  constructor(private readonly config: LightpandaConfig) {}

  async start(): Promise<Browser> {
    const port = await freeLoopbackPort();
    const child = spawn(
      this.config.executablePath,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        // One session per process: refuse a second CDP client.
        "--cdp-max-connections",
        "1",
        // Without this, iframes (card fields, for example) never load.
        "--load-resources",
        "iframe",
        "--disable-metrics",
        ...(this.config.extraArgs ?? []),
      ],
      {
        // Lightpanda sends usage telemetry unless this is set.
        env: { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    this.process = child;
    // A spawn that fails (no such binary) emits "error" and never "exit".
    this.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) =>
        resolve(`process exited (${code ?? signal})`),
      );
      child.once("error", (err) => resolve(err.message));
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    try {
      const endpoint = await waitForCdp(
        port,
        this.exited,
        this.config.startTimeoutMs ?? 10_000,
      );
      this.browser = await puppeteer.connect({
        browserWSEndpoint: endpoint,
        defaultViewport: null,
      });
    } catch (err) {
      await this.stop();
      throw new Error(
        `Lightpanda did not start: ${(err as Error).message}` +
          (stderr ? ` (stderr: ${stderr.trim().split("\n").pop()})` : ""),
      );
    }
    return this.browser;
  }

  /**
   * Lightpanda's default page has no browser context, so CDP calls on it
   * fail. A page in a new context works. Lightpanda allows one page per
   * connection, which matches one page per session.
   */
  async openPage(browser: Browser): Promise<Page> {
    const context = await browser.createBrowserContext();
    return context.newPage();
  }

  async stop(): Promise<void> {
    await this.browser?.disconnect().catch(() => {});
    this.browser = undefined;
    const child = this.process;
    const exited = this.exited;
    this.process = undefined;
    this.exited = undefined;
    if (child && exited) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited;
      clearTimeout(timer);
    }
  }
}

/** A port that was free a moment ago. Lightpanda fails to start if it is
 * taken in between, and the session reports the error. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/** Polls the CDP discovery endpoint until it answers, the process is gone,
 * or the timeout passes. Returns the browser WebSocket URL. */
async function waitForCdp(
  port: number,
  exited: Promise<string>,
  timeoutMs: number,
): Promise<string> {
  let gone: string | undefined;
  void exited.then((reason) => (gone = reason));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gone) throw new Error(gone);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const { webSocketDebuggerUrl } = (await res.json()) as {
          webSocketDebuggerUrl?: string;
        };
        return webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/`;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`CDP did not answer within ${timeoutMs} ms`);
}
