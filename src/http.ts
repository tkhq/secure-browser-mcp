/**
 * Hosted entrypoint: the same tool surface as src/index.ts, served as MCP
 * Streamable HTTP for agent platforms that connect by URL.
 *
 * This is a Turnkey-operated fill service (design 1 in EMG-89): the broker
 * and its browsers run here, so secret plaintext exists in this process
 * during a fill. See docs/THREAT-MODEL.md ("Hosted broker").
 *
 * Each tenant in SBM_TENANTS has its own endpoint, /t/{id}/mcp, with its
 * own Turnkey key and pending-fill store, and the broker is an OAuth 2.1
 * resource server for it. Each MCP session gets its own ToolContext (its
 * own browser, redaction registry, and view of the pending fills) and is
 * bound to the tenant, subject, and OAuth client that opened it. Closing
 * the session (DELETE, idle timeout, or shutdown) closes its browser.
 *
 * Protocol: the 2025-era session protocol (initialize, Mcp-Session-Id),
 * through to 2025-11-25. A 2026-07-28 request (no session, per-request
 * `_meta` envelope) gets an UnsupportedProtocolVersion error; see
 * rejectModern below.
 *
 * Configuration: docs/HOSTED.md.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  protectedResourceMetadata,
  wwwAuthenticate,
  type Challenge,
} from "./auth/challenge.js";
import { SCOPES } from "./auth/scopes.js";
import {
  checkAudiences,
  loadTenants,
  metadataUri,
  parsePublicUrl,
  tenantAudience,
  tenantIssuers,
  type TenantConfig,
} from "./auth/tenants.js";
import { JwksCache, verifyAccessToken } from "./auth/tokens.js";
import { InFlightIds } from "./inflight.js";
import {
  FilePendingFillStore,
  MemoryPendingFillStore,
  parseStateKey,
  scopedFills,
  tenantStateKey,
} from "./broker/pending-store.js";
import {
  makeBroker,
  sessionContext,
  tenantSecretsClient,
  type Broker,
} from "./runtime.js";
import { createServer, TOOLS } from "./server.js";
import type { ToolContext } from "./tools/tool.js";

const MAX_BODY_BYTES = 1_000_000;

/** JSON-RPC code for UnsupportedProtocolVersion (MCP 2026-07-28). */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** The dev endpoint's id. Not a valid tenant id, so it cannot collide. */
const DEV_ENDPOINT_ID = "_shared-token";

const SCOPE_BY_TOOL = new Map(TOOLS.map((t) => [t.name, t.scope]));

/** The caller a request was authenticated as. */
type Caller = {
  /** Binds sessions and parked fills. */
  principal: string;
  client: string | undefined;
  scopes: ReadonlySet<string>;
  /** Token expiry in ms since the epoch; absent for the dev token. */
  expiresAt?: number;
};

/** One MCP endpoint: a tenant, or the dev shared-token endpoint. */
type Endpoint = {
  id: string;
  broker: Broker;
  store: MemoryPendingFillStore;
  /** The caller for a bearer token, or undefined if it is not valid. */
  verify: (token: string) => Promise<Caller | undefined>;
  /** Protected Resource Metadata; the dev endpoint has none. */
  metadata?: { uri: string; doc: object };
};

type TenantEndpoint = Endpoint & { metadata: { uri: string; doc: object } };

type Session = {
  transport: NodeStreamableHTTPServerTransport;
  ctx: ToolContext;
  lastSeen: number;
  endpoint: string;
  principal: string;
  client: string | undefined;
  inFlight: InFlightIds;
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

/** A store per endpoint: its own directory, under its own derived key. */
function storeFactory(): (endpointId: string) => MemoryPendingFillStore {
  const dir = process.env["SBM_STATE_DIR"];
  if (!dir) {
    console.error(
      "secure-browser-mcp: SBM_STATE_DIR unset; pending fills do not " +
        "survive a restart",
    );
    return () => new MemoryPendingFillStore();
  }
  const key = process.env["SBM_STATE_KEY"];
  if (!key) throw new Error("SBM_STATE_DIR requires SBM_STATE_KEY");
  const master = parseStateKey(key);
  // Fills a shared-token broker parked directly in SBM_STATE_DIR belong to
  // no tenant, so they are not loaded (docs/HOSTED.md).
  const legacy = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".fill")).length
    : 0;
  if (legacy > 0) {
    console.error(
      `secure-browser-mcp: WARNING: ignoring ${legacy} parked fill(s) from ` +
        `a shared-token broker in ${dir}; their approvals must be restarted`,
    );
  }
  return (id) =>
    new FilePendingFillStore(
      join(dir, "tenants", id),
      tenantStateKey(master, id),
    );
}

/** RFC 6750 §2.1 b64token: the only characters a bearer token may hold. */
const B64TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;

/** The Bearer token; "none" when the request has no Bearer credentials,
 * which RFC 6750 §3.1 answers without an error code. */
function bearerToken(
  req: IncomingMessage,
): { token: string } | "none" | "malformed" {
  const header = req.headers.authorization;
  if (header === undefined || !/^Bearer(\s|$)/i.test(header)) return "none";
  const token = /^Bearer (\S+)$/i.exec(header)?.[1];
  return token && B64TOKEN.test(token) ? { token } : "malformed";
}

/** Constant-time compare; compares digests so lengths do not leak. */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

function tenantEndpoint(
  publicUrl: string,
  tenant: TenantConfig,
  jwks: JwksCache,
  makeStore: (id: string) => MemoryPendingFillStore,
): TenantEndpoint {
  const expect = {
    audience: tenantAudience(publicUrl, tenant),
    issuers: tenantIssuers(publicUrl, tenant),
    allowedClients: tenant.allowedClients,
  };
  return {
    id: tenant.id,
    broker: makeBroker(tenantSecretsClient(tenant)),
    store: makeStore(tenant.id),
    metadata: {
      uri: metadataUri(publicUrl, tenant.id),
      doc: protectedResourceMetadata(publicUrl, tenant),
    },
    verify: async (token) => {
      // Fail closed on every error, including an unreachable JWKS.
      const p = await verifyAccessToken(token, expect, jwks).catch(
        () => undefined,
      );
      return (
        p && {
          // (iss, sub) without the client, so the same subject can claim a
          // parked fill from another client.
          principal: JSON.stringify([p.issuer, p.subject]),
          client: p.client,
          scopes: p.scopes,
          expiresAt: p.expiresAt * 1_000,
        }
      );
    },
  };
}

function devEndpoint(
  token: string,
  makeStore: (id: string) => MemoryPendingFillStore,
): Endpoint {
  const caller: Caller = {
    principal: DEV_ENDPOINT_ID,
    client: undefined,
    scopes: new Set(SCOPES),
  };
  return {
    id: DEV_ENDPOINT_ID,
    broker: makeBroker(),
    store: makeStore(DEV_ENDPOINT_ID),
    verify: async (t) => (sameSecret(t, token) ? caller : undefined),
  };
}

/**
 * Scopes the body's tools/call messages need and the caller lacks. This is
 * the union over a batch, so one 403 names them all; SDK v2's per-tool
 * scopeChallenge answers a batch with its first challenge only.
 */
function missingScopes(body: unknown, caller: Caller): string[] {
  const messages = Array.isArray(body) ? body : [body];
  const missing = new Set<string>();
  for (const m of messages) {
    if (!m || typeof m !== "object" || m.method !== "tools/call") continue;
    const name = (m.params as { name?: unknown } | undefined)?.name;
    // Unknown tools need no scope here; the MCP server rejects them.
    const scope =
      typeof name === "string" ? SCOPE_BY_TOOL.get(name) : undefined;
    if (scope && !caller.scopes.has(scope)) missing.add(scope);
  }
  return [...missing];
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

function rpcError(
  res: ServerResponse,
  status: number,
  message: string,
  code = -32000,
) {
  send(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
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

function refuse(
  res: ServerResponse,
  status: 400 | 401 | 403,
  endpoint: Endpoint,
  challenge: Omit<Challenge, "resourceMetadata">,
) {
  const header = endpoint.metadata
    ? wwwAuthenticate({ ...challenge, resourceMetadata: endpoint.metadata.uri })
    : challenge.error
      ? `Bearer error="${challenge.error}"`
      : "Bearer";
  send(
    res,
    status,
    {
      error: challenge.error ?? "unauthorized",
      ...(challenge.description
        ? { error_description: challenge.description }
        : {}),
    },
    { "www-authenticate": header },
  );
}

/** The request's caller, or undefined after answering 400 or 401. */
async function authenticate(
  endpoint: Endpoint,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Caller | undefined> {
  const bearer = bearerToken(req);
  if (bearer === "none") {
    refuse(res, 401, endpoint, { scopes: SCOPES });
  } else if (bearer === "malformed") {
    refuse(res, 400, endpoint, {
      error: "invalid_request",
      description: "The Authorization header must be Bearer <token>",
      scopes: SCOPES,
    });
  } else {
    const caller = await endpoint.verify(bearer.token);
    if (caller) return caller;
    refuse(res, 401, endpoint, {
      error: "invalid_token",
      description: "The access token is not valid for this resource",
      scopes: SCOPES,
    });
  }
  return undefined;
}

/**
 * End a GET (SSE) stream when the token that opened it expires. POSTs are
 * checked one by one, but a GET stream would outlive its token. The
 * transport allows one GET stream per session, so this is that stream.
 */
function endStreamAtExpiry(
  s: Session,
  res: ServerResponse,
  expiresAt: number,
): void {
  const timer = setTimeout(
    () => {
      s.transport.closeStandaloneSSEStream();
      // If closing the stream does not end the response, drop it.
      setTimeout(() => res.destroy(), 1_000).unref();
    },
    Math.max(0, expiresAt - Date.now()),
  );
  timer.unref();
  res.once("close", () => clearTimeout(timer));
}

async function main(): Promise<void> {
  const host = process.env["SBM_HTTP_HOST"] ?? "127.0.0.1";
  const port = envInt("SBM_HTTP_PORT", 8080);
  const maxSessions = envInt("SBM_MAX_SESSIONS", 8);
  const idleMs = envInt("SBM_SESSION_IDLE_S", 1800) * 1_000;
  const allowedOrigins = parseAllowedOrigins(
    process.env["SBM_ALLOWED_ORIGINS"],
  );
  const makeStore = storeFactory();

  const tenants = new Map<string, TenantEndpoint>();
  const tenantsPath = process.env["SBM_TENANTS"];
  if (tenantsPath) {
    const rawPublicUrl = process.env["SBM_PUBLIC_URL"];
    if (!rawPublicUrl) throw new Error("SBM_TENANTS requires SBM_PUBLIC_URL");
    const publicUrl = parsePublicUrl(rawPublicUrl);
    const jwks = new JwksCache();
    const configs = loadTenants(tenantsPath);
    checkAudiences(publicUrl, configs);
    for (const tenant of configs) {
      tenants.set(
        tenant.id,
        tenantEndpoint(publicUrl, tenant, jwks, makeStore),
      );
      if (tenant.backend === "mock") {
        console.error(
          `secure-browser-mcp: WARNING: tenant ${tenant.id} uses the mock ` +
            "secrets backend",
        );
      }
    }
  }

  // The step-1 shared token, kept for local development only.
  let dev: Endpoint | undefined;
  const sharedToken = process.env["SBM_HTTP_TOKEN"];
  if (sharedToken) {
    const flag = (process.env["SBM_DEV_SHARED_TOKEN"] ?? "").toLowerCase();
    if (flag !== "1" && flag !== "true") {
      throw new Error(
        "SBM_HTTP_TOKEN is for development only: set SBM_DEV_SHARED_TOKEN=1 " +
          "to serve /mcp with it, or unset it and configure SBM_TENANTS",
      );
    }
    // A token the header parser would never accept would 401 every request.
    if (!B64TOKEN.test(sharedToken)) {
      throw new Error(
        "SBM_HTTP_TOKEN may contain only letters, digits, and - . _ ~ + / " +
          "(with trailing =); openssl rand -hex 32 makes one",
      );
    }
    dev = devEndpoint(sharedToken, makeStore);
    console.error(
      "secure-browser-mcp: WARNING: SBM_DEV_SHARED_TOKEN is on. /mcp accepts " +
        "one shared bearer token with every scope and the TURNKEY_* key. " +
        "Do not use this in production.",
    );
  }
  if (tenants.size === 0 && !dev) {
    throw new Error("Configure tenants with SBM_TENANTS and SBM_PUBLIC_URL");
  }
  // By default each endpoint gets an equal share of the session slots, and
  // one principal cannot take all of its tenant's.
  const endpoints = tenants.size + (dev ? 1 : 0);
  const maxPerTenant = envInt(
    "SBM_MAX_SESSIONS_PER_TENANT",
    Math.max(1, Math.floor(maxSessions / endpoints)),
  );
  const maxPerPrincipal = envInt(
    "SBM_MAX_SESSIONS_PER_PRINCIPAL",
    Math.min(4, maxPerTenant),
  );

  const sessions = new Map<string, Session>();
  const isLive = (owner: string) => sessions.has(owner);

  const closeSession = async (id: string) => {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    await s.ctx.session.close().catch(() => {});
    await s.transport.close().catch(() => {});
  };

  const openSession = async (
    endpoint: Endpoint,
    caller: Caller,
  ): Promise<NodeStreamableHTTPServerTransport> => {
    // The session id doubles as the owner of this session's pending fills,
    // so it is fixed before the context is built.
    const id = randomUUID();
    const fills = scopedFills(endpoint.store, {
      owner: id,
      principal: caller.principal,
      isLive,
    });
    const ctx = sessionContext(endpoint.broker, fills);
    const inFlight = new InFlightIds();
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: () => {
        sessions.set(id, {
          transport,
          ctx,
          lastSeen: Date.now(),
          endpoint: endpoint.id,
          principal: caller.principal,
          client: caller.client,
          inFlight,
        });
      },
    });
    transport.onclose = () => void closeSession(id);
    await createServer(ctx).connect(transport);
    // Watch what passes between the transport and the server, so an id is
    // released only when the server is done with it.
    const deliver = transport.onmessage;
    transport.onmessage = (message, extra) => {
      inFlight.inbound(message);
      deliver?.(message, extra);
    };
    const sendToClient = transport.send.bind(transport);
    transport.send = async (message, options) => {
      try {
        await sendToClient(message, options);
      } finally {
        inFlight.outbound(message);
      }
    };
    return transport;
  };

  const handleMcp = async (
    endpoint: Endpoint,
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    const caller = await authenticate(endpoint, req, res);
    if (!caller) return;
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

    // Checked against the token sent with each request, so a session's
    // rights follow its current token.
    const missing = missingScopes(body, caller);
    if (missing.length > 0) {
      return refuse(res, 403, endpoint, {
        error: "insufficient_scope",
        description: `This tool requires ${missing.join(" ")}`,
        scopes: missing,
      });
    }

    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const s = sessions.get(sessionId);
      // To anyone but the endpoint, principal, and client that opened it,
      // the session does not exist. 404 tells the client to start a new one.
      // A session opened by a token without a client claim (client
      // undefined) takes only tokens without one, and the reverse: it is
      // bound to (tenant, iss, sub) alone. allowedClients makes the claim
      // required.
      if (
        !s ||
        s.endpoint !== endpoint.id ||
        s.principal !== caller.principal ||
        s.client !== caller.client
      ) {
        return rpcError(res, 404, "Session not found");
      }
      s.lastSeen = Date.now();
      const reserved = s.inFlight.reserve(body);
      if (!reserved.ok) {
        // id null: an answer with the reused id would look, to the client,
        // like the answer to the request that holds it.
        return rpcError(
          res,
          409,
          `Request id ${JSON.stringify(reserved.id)} is already in use ` +
            "in this session",
          -32600,
        );
      }
      res.once("finish", reserved.done);
      res.once("close", reserved.done);
      if (req.method === "GET" && caller.expiresAt !== undefined) {
        endStreamAtExpiry(s, res, caller.expiresAt);
      }
      return s.transport.handleRequest(req, res, body);
    }

    if (req.method !== "POST" || !isInitializeRequest(body)) {
      return rpcError(res, 400, "Missing mcp-session-id");
    }
    // A session holds a browser, so opening one needs some sbm:* scope. The
    // challenge names sbm:browse, the scope every useful session needs.
    if (!SCOPES.some((s) => caller.scopes.has(s))) {
      return refuse(res, 403, endpoint, {
        error: "insufficient_scope",
        description: "Opening a session needs at least one sbm:* scope",
        scopes: ["sbm:browse"],
      });
    }
    if (sessions.size >= maxSessions) {
      return rpcError(res, 503, "Broker is at its session limit");
    }
    const tenantSessions = [...sessions.values()].filter(
      (s) => s.endpoint === endpoint.id,
    );
    const callerSessions = tenantSessions.filter(
      (s) => s.principal === caller.principal,
    ).length;
    // The dev endpoint has one principal, so only the tenant cap applies.
    if (endpoint !== dev && callerSessions >= maxPerPrincipal) {
      return rpcError(res, 503, "This caller is at its session limit");
    }
    if (tenantSessions.length >= maxPerTenant) {
      return rpcError(res, 503, "This tenant is at its session limit");
    }
    const transport = await openSession(endpoint, caller);
    await transport.handleRequest(req, res, body);
  };

  const route = (
    path: string,
  ):
    | { kind: "mcp"; endpoint: Endpoint }
    | { kind: "metadata"; doc: object }
    | undefined => {
    if (path === "/mcp" && dev) return { kind: "mcp", endpoint: dev };
    const m =
      /^(\/\.well-known\/oauth-protected-resource)?\/t\/([^/]+)\/mcp$/.exec(
        path,
      );
    const endpoint = m && tenants.get(m[2]!);
    if (!m || !endpoint) return undefined;
    return m[1]
      ? { kind: "metadata", doc: endpoint.metadata.doc }
      : { kind: "mcp", endpoint };
  };

  const http = createHttpServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz") {
      return send(res, 200, { ok: true, tenants: tenants.size });
    }
    const target = route(path);
    if (!target) return send(res, 404, { error: "not found" });
    if (target.kind === "metadata") {
      if (req.method !== "GET") {
        return send(
          res,
          405,
          { error: "method not allowed" },
          { allow: "GET" },
        );
      }
      // Public, and holds nothing the 401 challenge does not point at, so
      // it skips the Origin check; browser clients fetch it cross-origin.
      return send(res, 200, target.doc, {
        "access-control-allow-origin": "*",
        "cache-control": "max-age=300",
      });
    }
    // Before auth and before any session work.
    if (!originAllowed(req, allowedOrigins)) {
      return rpcError(res, 403, "Origin not allowed");
    }
    handleMcp(target.endpoint, req, res).catch((err) => {
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
    `secure-browser-mcp: listening on http://${host}:${port} ` +
      `(tenants: ${[...tenants.keys()].join(", ") || "none"}` +
      `${dev ? "; dev /mcp" : ""})`,
  );

  // Pending fills stay in the stores; browsers do not outlive the process.
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
