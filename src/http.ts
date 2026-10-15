/**
 * Hosted entrypoint: the same tool surface as src/index.ts, served as MCP
 * Streamable HTTP at /mcp for agent platforms that connect by URL.
 *
 * This is a Turnkey-operated fill service (design 1 in EMG-89): the broker
 * and its browsers run here, so secret plaintext exists in this process
 * during a fill. See docs/THREAT-MODEL.md ("Hosted broker").
 *
 * Each MCP session gets its own ToolContext: its own Chrome process, its own
 * redaction registry, and a view of the pending-fill store that shows only
 * its own fills. Closing the session (DELETE, idle timeout, or shutdown)
 * closes its browser.
 *
 * Protocol: the 2025-era session protocol (initialize, Mcp-Session-Id),
 * through to 2025-11-25. A 2026-07-28 request (no session, per-request
 * `_meta` envelope) gets an UnsupportedProtocolVersion error; see
 * rejectModern below.
 *
 * Environment:
 *   SBM_HTTP_TOKEN      required. Clients send `Authorization: Bearer <token>`.
 *   SBM_HTTP_HOST       listen address (default 127.0.0.1; 0.0.0.0 in the image)
 *   SBM_HTTP_PORT       listen port (default 8080)
 *   SBM_STATE_DIR       directory for encrypted pending fills. Without it,
 *                       pending fills are in memory and a restart strands them.
 *   SBM_STATE_KEY       32-byte key (hex or base64), required with SBM_STATE_DIR
 *   SBM_MAX_SESSIONS    concurrent agent sessions (default 8)
 *   SBM_SESSION_IDLE_S  close sessions idle this long (default 1800)
 *   SBM_ALLOWED_ORIGINS comma-separated origins (https://app.example.com)
 *                       that browser clients may call from. Default empty: a
 *                       request with any Origin header gets 403. Requests
 *                       without Origin (non-browser clients) are allowed.
 * plus the TURNKEY_* and SBM_* variables the stdio broker reads.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  NodeStreamableHTTPServerTransport,
  toWebRequest,
  type NodeIncomingMessageLike,
} from "@modelcontextprotocol/node";
import {
  isInitializeRequest,
  isLegacyRequest,
  PROTOCOL_VERSION_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";

import {
  FilePendingFillStore,
  MemoryPendingFillStore,
  parseStateKey,
  scopedFills,
} from "./broker/pending-store.js";
import { makeBroker, sessionContext } from "./runtime.js";
import { createServer } from "./server.js";
import type { ToolContext } from "./tools/tool.js";

const MAX_BODY_BYTES = 1_000_000;

/** JSON-RPC code for UnsupportedProtocolVersion (MCP 2026-07-28). */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

type Session = {
  transport: NodeStreamableHTTPServerTransport;
  ctx: ToolContext;
  lastSeen: number;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function makeStore(): MemoryPendingFillStore {
  const dir = process.env["SBM_STATE_DIR"];
  if (!dir) {
    console.error(
      "secure-browser-mcp: SBM_STATE_DIR unset; pending fills do not " +
        "survive a restart",
    );
    return new MemoryPendingFillStore();
  }
  const key = process.env["SBM_STATE_KEY"];
  if (!key) throw new Error("SBM_STATE_DIR requires SBM_STATE_KEY");
  return new FilePendingFillStore(dir, parseStateKey(key));
}

/**
 * Parse SBM_ALLOWED_ORIGINS into serialized origins. Each entry must be a
 * bare origin (scheme, host, optional port); anything else stops startup,
 * so a typo cannot silently allow or refuse a client.
 */
function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const item of (raw ?? "").split(",")) {
    const entry = item.trim();
    if (entry === "") continue;
    let url: URL | undefined;
    try {
      url = new URL(entry);
    } catch {}
    if (
      !url ||
      url.origin === "null" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new Error(
        `SBM_ALLOWED_ORIGINS: "${entry}" is not an origin ` +
          "(expected scheme://host[:port])",
      );
    }
    origins.add(url.origin);
  }
  return origins;
}

/**
 * Origin check (MCP Streamable HTTP: servers MUST validate Origin, to stop
 * DNS rebinding and cross-site calls from a browser). A request without
 * Origin is not from a browser page and passes. A present Origin must match
 * an allowed origin exactly, as the browser serializes it; "null" and
 * malformed values never match.
 */
function originAllowed(req: IncomingMessage, allowed: Set<string>): boolean {
  const origin = req.headers.origin;
  return origin === undefined || allowed.has(origin);
}

/** Constant-time bearer check; compares digests so lengths do not leak. */
function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(match[1]!), digest(token));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, message: string) {
  send(res, status, {
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

/**
 * Answer a 2026-07-28 (stateless, `server/discover`) request. The broker
 * serves only the 2025-era session protocol: one browser per
 * `Mcp-Session-Id`. The 2026 revision has no sessions, so it needs a
 * different browser-handle model, which is not built yet.
 *
 * The answer is the spec's UnsupportedProtocolVersion error, listing the
 * 2025-era versions the broker serves. A client in version-negotiation
 * `auto` mode reads this and falls back to `initialize`; a client pinned to
 * 2026-07-28 fails with a clear error instead of hanging.
 */
function rejectModern(
  res: ServerResponse,
  req: IncomingMessage,
  body: unknown,
) {
  const msg = (Array.isArray(body) ? body[0] : body) as
    { id?: unknown; params?: { _meta?: Record<string, unknown> } } | undefined;
  const claimed = msg?.params?._meta?.[PROTOCOL_VERSION_META_KEY];
  const header = req.headers["mcp-protocol-version"];
  const requested =
    typeof claimed === "string"
      ? claimed
      : typeof header === "string"
        ? header
        : "unknown";
  const id =
    typeof msg?.id === "string" || typeof msg?.id === "number" ? msg.id : null;
  send(res, 400, {
    jsonrpc: "2.0",
    error: {
      code: UNSUPPORTED_PROTOCOL_VERSION,
      message:
        `Unsupported protocol version: ${requested}. This broker serves ` +
        "the 2025-era session protocol only; connect with initialize " +
        `(protocol version ${SUPPORTED_PROTOCOL_VERSIONS[0]}).`,
      data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested },
    },
    id,
  });
}

async function main(): Promise<void> {
  const token = process.env["SBM_HTTP_TOKEN"];
  if (!token) throw new Error("SBM_HTTP_TOKEN is required");
  const host = process.env["SBM_HTTP_HOST"] ?? "127.0.0.1";
  const port = envInt("SBM_HTTP_PORT", 8080);
  const maxSessions = envInt("SBM_MAX_SESSIONS", 8);
  const idleMs = envInt("SBM_SESSION_IDLE_S", 1800) * 1_000;
  const allowedOrigins = parseAllowedOrigins(
    process.env["SBM_ALLOWED_ORIGINS"],
  );

  const broker = makeBroker();
  const store = makeStore();
  const sessions = new Map<string, Session>();
  const isLive = (owner: string) => sessions.has(owner);

  const closeSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.ctx.session.close().catch(() => {});
    await s.transport.close().catch(() => {});
  };

  const openSession = async (): Promise<NodeStreamableHTTPServerTransport> => {
    // The session id doubles as the owner of this session's pending fills,
    // so it is fixed before the context is built.
    const id = randomUUID();
    const ctx = sessionContext(broker, scopedFills(store, id, isLive));
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: () => {
        sessions.set(id, { transport, ctx, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => void closeSession(id);
    await createServer(ctx).connect(transport);
    return transport;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readJson(req) : undefined;

    // Era routing (SDK v2 legacy-clients guide): 2025-era traffic goes to the
    // sessionful transports below. isLegacyRequest is the SDK's own
    // classifier, so this branch agrees with what createMcpHandler would do.
    // GET and DELETE are session operations and always classify legacy.
    // The cast only bridges `method?: string` under exactOptionalPropertyTypes.
    if (
      req.method === "POST" &&
      !(await isLegacyRequest(
        await toWebRequest(req as NodeIncomingMessageLike, body),
        body,
      ))
    ) {
      return rejectModern(res, req, body);
    }

    if (typeof sessionId === "string") {
      const s = sessions.get(sessionId);
      // 404 tells the client to start a new session (MCP spec), which is
      // what happens after a broker restart.
      if (!s) return rpcError(res, 404, "Session not found");
      s.lastSeen = Date.now();
      return s.transport.handleRequest(req, res, body);
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      return rpcError(res, 400, "Missing mcp-session-id");
    }
    if (sessions.size >= maxSessions) {
      return rpcError(res, 503, "Broker is at its session limit");
    }
    const transport = await openSession();
    await transport.handleRequest(req, res, body);
  };

  const http = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      return send(res, 200, {
        ok: true,
        backend: broker.backend,
        browser: broker.browser,
      });
    }
    if (path !== "/mcp") return send(res, 404, { error: "not found" });
    // Before auth and before any session work.
    if (!originAllowed(req, allowedOrigins)) {
      return rpcError(res, 403, "Origin not allowed");
    }
    if (!authorized(req, token)) {
      return send(
        res,
        401,
        { error: "unauthorized" },
        {
          "www-authenticate": "Bearer",
        },
      );
    }
    handleMcp(req, res).catch((err) => {
      console.error("secure-browser-mcp: request failed:", err);
      if (!res.headersSent) rpcError(res, 400, "Bad request");
      else res.end();
    });
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) void closeSession(id);
    }
  }, 60_000);
  sweep.unref();

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  console.error(
    `secure-browser-mcp: listening on http://${host}:${port}/mcp ` +
      `(backend: ${broker.backend}, browser: ${broker.browser})`,
  );

  // Pending fills stay in the store; browsers do not outlive the process.
  const shutdown = () => {
    http.close();
    void Promise.all([...sessions.keys()].map(closeSession)).finally(() =>
      process.exit(0),
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("secure-browser-mcp: fatal:", err);
  process.exit(1);
});
