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
 * Environment:
 *   SBM_HTTP_TOKEN      required. Clients send `Authorization: Bearer <token>`.
 *   SBM_HTTP_HOST       listen address (default 127.0.0.1; 0.0.0.0 in the image)
 *   SBM_HTTP_PORT       listen port (default 8080)
 *   SBM_STATE_DIR       directory for encrypted pending fills. Without it,
 *                       pending fills are in memory and a restart strands them.
 *   SBM_STATE_KEY       32-byte key (hex or base64), required with SBM_STATE_DIR
 *   SBM_MAX_SESSIONS    concurrent agent sessions (default 8)
 *   SBM_SESSION_IDLE_S  close sessions idle this long (default 1800)
 * plus the TURNKEY_* and SBM_* variables the stdio broker reads.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

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

type Session = {
  transport: StreamableHTTPServerTransport;
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

async function main(): Promise<void> {
  const token = process.env["SBM_HTTP_TOKEN"];
  if (!token) throw new Error("SBM_HTTP_TOKEN is required");
  const host = process.env["SBM_HTTP_HOST"] ?? "127.0.0.1";
  const port = envInt("SBM_HTTP_PORT", 8080);
  const maxSessions = envInt("SBM_MAX_SESSIONS", 8);
  const idleMs = envInt("SBM_SESSION_IDLE_S", 1800) * 1_000;

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

  const openSession = async (): Promise<StreamableHTTPServerTransport> => {
    // The session id doubles as the owner of this session's pending fills,
    // so it is fixed before the context is built.
    const id = randomUUID();
    const ctx = sessionContext(broker, scopedFills(store, id, isLive));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: () => {
        sessions.set(id, { transport, ctx, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => void closeSession(id);
    // The cast only bridges the SDK's optional-property typing under
    // exactOptionalPropertyTypes.
    await createServer(ctx).connect(transport as Transport);
    return transport;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    const sessionId = req.headers["mcp-session-id"];
    const body = req.method === "POST" ? await readJson(req) : undefined;

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
