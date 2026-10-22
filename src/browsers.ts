/**
 * Browser handles (EMG-288): browsers a caller opens with open_browser and
 * names by `browser_id` in later tool calls, so a browser outlives the
 * connection that opened it.
 *
 * MCP 2026-07-28 has no protocol sessions, so state across calls must be a
 * handle the server mints and the client passes as an ordinary argument.
 * Some 2025-era clients (the Arcade gateway) open a new session for every
 * tool call, which loses a browser tied to the session. Both use handles.
 *
 * A handle holds what a 2025 session holds: its own browser, redaction
 * registry, and view of the pending fills. It is bound to the endpoint,
 * principal, and OAuth client that opened it, the same binding a hosted
 * session has. To anyone else it does not exist: a wrong owner gets the
 * same "unknown browser_id" as an id that was never minted. The id is 192
 * random bits, so it cannot be guessed either.
 *
 * Handles end with close_browser, after the idle timeout, or when the
 * process stops. The caps bound how many browsers callers can hold.
 */
import { randomBytes } from "node:crypto";

import { RedactionRegistry } from "@turnkey/browser-secrets";

import type { PendingFills } from "./broker/pending-store.js";
import type { BrowserHost } from "./browser/hosts.js";
import { BrowserSession } from "./browser/session.js";

/** One browser's state: what tools act on and redact with. */
export type BrowserContext = {
  session: BrowserSession;
  registry: RedactionRegistry;
  /** This browser's parked fills (see src/broker/pending-store.ts). */
  pendingFills: PendingFills;
};

/** Who a handle answers to. */
export type HandleOwner = {
  endpoint: string;
  principal: string;
  client: string | undefined;
};

export type HandleLimits = {
  /** Handles in the whole process. */
  max: number;
  /** Handles per endpoint (tenant). */
  perEndpoint: number;
  /** Handles per principal of an endpoint; Infinity for none. */
  perPrincipal: (owner: HandleOwner) => number;
};

type Handle = {
  owner: HandleOwner;
  ctx: BrowserContext;
  lastSeen: number;
  /** Tool calls running in this browser. The sweep skips a busy handle. */
  active: number;
};

const sameOwner = (a: HandleOwner, b: HandleOwner) =>
  a.endpoint === b.endpoint &&
  a.principal === b.principal &&
  a.client === b.client;

export class UnknownBrowserError extends Error {
  constructor(browserId: string) {
    super(
      `Unknown browser_id: ${browserId}. It was closed, timed out, or ` +
        "belongs to another caller. Call open_browser for a new one.",
    );
    this.name = "UnknownBrowserError";
  }
}

export class BrowserLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserLimitError";
  }
}

export class BrowserHandles {
  private readonly handles = new Map<string, Handle>();

  constructor(
    private readonly limits: HandleLimits,
    readonly idleMs: number,
  ) {}

  /**
   * Mint a handle for `owner`. `make` builds its browser context; the id is
   * passed in so the context can use it as the owner of its pending fills.
   * The browser itself starts on the first tool call that needs it.
   */
  open(owner: HandleOwner, make: (browserId: string) => BrowserContext) {
    const all = [...this.handles.values()];
    const endpoint = all.filter((h) => h.owner.endpoint === owner.endpoint);
    const mine = endpoint.filter((h) => h.owner.principal === owner.principal);
    if (mine.length >= this.limits.perPrincipal(owner)) {
      throw new BrowserLimitError(
        "This caller has the most browsers it may hold open. Call " +
          "close_browser on one it no longer needs.",
      );
    }
    if (endpoint.length >= this.limits.perEndpoint) {
      throw new BrowserLimitError("This tenant is at its browser limit");
    }
    if (all.length >= this.limits.max) {
      throw new BrowserLimitError("Broker is at its browser limit");
    }
    const id = `br_${randomBytes(24).toString("base64url")}`;
    this.handles.set(id, {
      owner,
      ctx: make(id),
      lastSeen: Date.now(),
      active: 0,
    });
    return id;
  }

  /** Run `fn` in the browser `browserId` names, if `owner` holds it. */
  async use<T>(
    browserId: string,
    owner: HandleOwner,
    fn: (ctx: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const h = this.handles.get(browserId);
    if (!h || !sameOwner(h.owner, owner)) {
      throw new UnknownBrowserError(browserId);
    }
    h.active++;
    h.lastSeen = Date.now();
    try {
      return await fn(h.ctx);
    } finally {
      h.active--;
      h.lastSeen = Date.now();
    }
  }

  /** Close `browserId` if `owner` holds it; false if it does not. */
  async close(browserId: string, owner: HandleOwner): Promise<boolean> {
    const h = this.handles.get(browserId);
    if (!h || !sameOwner(h.owner, owner)) return false;
    await this.drop(browserId);
    return true;
  }

  /** Whether a handle exists, for pending-fill ownership checks. */
  has(browserId: string): boolean {
    return this.handles.has(browserId);
  }

  get size(): number {
    return this.handles.size;
  }

  /** Close every handle idle longer than the timeout and not in use. */
  sweep(now = Date.now()): Promise<void> {
    const cutoff = now - this.idleMs;
    const idle = [...this.handles].filter(
      ([, h]) => h.active === 0 && h.lastSeen < cutoff,
    );
    return Promise.all(idle.map(([id]) => this.drop(id))).then(() => {});
  }

  closeAll(): Promise<void> {
    return Promise.all(
      [...this.handles.keys()].map((id) => this.drop(id)),
    ).then(() => {});
  }

  private async drop(browserId: string): Promise<void> {
    const h = this.handles.get(browserId);
    if (!h) return;
    this.handles.delete(browserId);
    // Parked fills stay in the store. Their owner is gone, so another
    // browser of the same principal can claim them by fill_id.
    await h.ctx.session.close().catch(() => {});
  }
}

/**
 * The browsers one connection can reach: a 2025 session, one 2026-07-28
 * request, or the stdio process.
 */
export type BrowserScope = {
  /**
   * Run `fn` in a browser: the one `browserId` names, or else the
   * connection's own browser. With `required`, a connection without its own
   * browser must name one; without it, `fn` gets a context with no browser
   * (for tools that do not touch the page).
   */
  run<T>(
    browserId: string | undefined,
    required: boolean,
    fn: (ctx: BrowserContext) => Promise<T>,
  ): Promise<T>;
  /** Mint a handle for this connection's caller. */
  open(): string;
  /** Close a handle this connection's caller holds; false if it holds
   * none by that id. */
  close(browserId: string): Promise<boolean>;
  idleSeconds: number;
};

const NO_HOST: BrowserHost = {
  kind: "local",
  start: () => Promise.reject(new Error("This call has no browser")),
  stop: () => Promise.resolve(),
};

const NO_FILLS: PendingFills = {
  list: () => [],
  get: async () => undefined,
  put: () => Promise.reject(new Error("This call has no browser")),
  delete: async () => {},
};

/** A context for a tool that uses no browser. */
function detached(): BrowserContext {
  return {
    session: new BrowserSession(NO_HOST),
    registry: new RedactionRegistry(),
    pendingFills: NO_FILLS,
  };
}

export function browserScope(opts: {
  handles: BrowserHandles;
  owner: HandleOwner;
  /** Builds a handle's context (see BrowserHandles.open). */
  make: (browserId: string) => BrowserContext;
  /** The connection's own browser: a 2025 session's, or stdio's. The
   * 2026-07-28 leg has none. */
  implicit?: BrowserContext | undefined;
}): BrowserScope {
  const { handles, owner, make, implicit } = opts;
  return {
    run: (browserId, required, fn) => {
      if (browserId !== undefined) return handles.use(browserId, owner, fn);
      if (implicit) return fn(implicit);
      if (required) {
        return Promise.reject(
          new Error(
            "This tool needs a browser_id on this connection. Call " +
              "open_browser and pass the browser_id it returns.",
          ),
        );
      }
      return fn(detached());
    },
    open: () => handles.open(owner, make),
    close: (browserId) => handles.close(browserId, owner),
    idleSeconds: Math.floor(handles.idleMs / 1_000),
  };
}
