import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { FIXTURE_ORIGIN, startFixtureServer } from "./fixtures/serve.js";
import { McpStdioClient } from "./mcp-client.js";
import { MockAuthServer } from "./mock-auth-server.js";

/**
 * The hosted broker as an OAuth resource server with two tenants, black
 * box: EMG-89 step 2 acceptance.
 *
 *  - alpha trusts authorization server A and holds the default mock
 *    secrets, with demo-login-password behind consensus.
 *  - beta trusts both A and B and holds one secret of its own. Trusting A
 *    too means a token A minted for alpha fails at beta on audience alone.
 *  - gamma trusts B and sets an `audience` override, for an authorization
 *    server that cannot put the resource URI in `aud`.
 *  - delta trusts A and holds the default mock secrets, for tests that
 *    need sessions of their own.
 *  - epsilon trusts A and accepts only the clients in its allowedClients.
 */

const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed
const BETA_PLAINTEXT = "beta-only-plaintext-0000";
const ALL = "sbm:browse sbm:fill sbm:refs";
const GAMMA_AUDIENCE = "api://sbm-gamma";
const ALLOWED_ORIGIN = "https://allowed.example";
const LIST_DELAY_MS = 1_000;

const work = mkdtempSync(join(tmpdir(), "sbm-oauth-"));
const stateDir = join(work, "state");
const stateKey = randomBytes(32).toString("hex");
const port = 20_000 + Math.floor(Math.random() * 2_000);
const base = `http://127.0.0.1:${port}`;
const mcpUrl = (tenant: string) => `${base}/t/${tenant}/mcp`;
const prmUrl = (tenant: string) =>
  `${base}/.well-known/oauth-protected-resource/t/${tenant}/mcp`;

let asA: MockAuthServer;
let asB: MockAuthServer;
let fixture: { stop: () => void };
let broker: { stop: () => Promise<void> };
const tenantsFile = join(work, "tenants.json");
/** Every response body the server sent, for leak assertions. */
let transcript = "";

async function startBroker() {
  const proc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      TURNKEY_API_PUBLIC_KEY: "",
      TURNKEY_API_PRIVATE_KEY: "",
      TURNKEY_ORGANIZATION_ID: "",
      SBM_HTTP_TOKEN: "",
      SBM_HEADLESS: "true",
      SBM_TENANTS: tenantsFile,
      SBM_PUBLIC_URL: base,
      SBM_HTTP_PORT: String(port),
      SBM_STATE_DIR: stateDir,
      SBM_STATE_KEY: stateKey,
      // Five tenants, five slots each by default, and four for each
      // principal (the default cap).
      SBM_MAX_SESSIONS: "25",
      SBM_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      SBM_MOCK_CONSENSUS: "demo-login-password",
      SBM_MOCK_CONSENSUS_DELAY_MS: "2000",
      // Long enough to hold a list_secret_refs call in flight.
      SBM_MOCK_LIST_DELAY_MS: String(LIST_DELAY_MS),
    },
  });
  let log = "";
  for await (const chunk of proc.stderr) {
    log += new TextDecoder().decode(chunk);
    if (log.includes("listening on")) break;
  }
  if (!log.includes("listening on")) throw new Error(`broker: ${log}`);
  return {
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

const token = (
  as: MockAuthServer,
  tenant: string,
  opts: { sub?: string; scope?: string; claims?: Record<string, unknown> } = {},
) => as.mint({ aud: mcpUrl(tenant), scope: ALL, ...opts });

type Session = {
  client: Client;
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ isError: boolean; body: any; text: string }>;
};

async function connect(tenant: string, bearer: string): Promise<Session> {
  const client = new Client({ name: "oauth-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl(tenant)), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        void res
          .clone()
          .text()
          .then((t) => (transcript += t))
          .catch(() => {});
        return res;
      },
    }),
  );
  const call: Session["call"] = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = result.content[0]?.text ?? "";
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { isError: result.isError === true, body, text };
  };
  return { client, call };
}

/** One raw JSON-RPC POST, for status codes and headers the SDK hides. A
 * message gets `jsonrpc` and `id: 1` unless it sets its own; an array is
 * sent as given, as a batch. */
async function rpc(
  tenant: string,
  bearer: string | undefined,
  message: object | object[],
  sessionId?: string,
): Promise<Response> {
  const res = await fetch(mcpUrl(tenant), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(
      Array.isArray(message) ? message : { jsonrpc: "2.0", id: 1, ...message },
    ),
  });
  transcript += await res.clone().text();
  return res;
}

const initialize = {
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw", version: "0" },
  },
};

/** Open a session over raw HTTP; returns its id. */
async function rawSession(tenant: string, bearer: string): Promise<string> {
  const res = await rpc(tenant, bearer, initialize);
  expect(res.status).toBe(200);
  const id = res.headers.get("mcp-session-id")!;
  await fetch(mcpUrl(tenant), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": id,
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  return id;
}

async function openLogin(s: Session) {
  await s.call("navigate", { url: `${FIXTURE_ORIGIN}/login` });
  const snap = (await s.call("snapshot")).body;
  return snap.elements.find((e: { type?: string }) => e.type === "password")
    .uid as string;
}

const refNames = async (s: Session) =>
  ((await s.call("list_secret_refs")).body.refs as { name: string }[]).map(
    (r) => r.name,
  );

beforeAll(async () => {
  asA = await MockAuthServer.start();
  asB = await MockAuthServer.start();
  writeFileSync(
    tenantsFile,
    JSON.stringify({
      tenants: [
        {
          id: "alpha",
          backend: "mock",
          issuers: [{ issuer: asA.issuer, jwksUri: asA.jwksUri }],
        },
        {
          id: "beta",
          backend: "mock",
          issuers: [
            { issuer: asB.issuer, jwksUri: asB.jwksUri },
            { issuer: asA.issuer, jwksUri: asA.jwksUri },
          ],
          authorizationServers: [asB.issuer],
          mockSecrets: [
            {
              name: "beta-login-password",
              value: BETA_PLAINTEXT,
              staticProperties: {
                "sbm:origin": FIXTURE_ORIGIN,
                "sbm:url-pattern": "/login*",
                "sbm:selector": "input[type=password]",
              },
            },
          ],
        },
        {
          id: "gamma",
          backend: "mock",
          issuers: [{ issuer: asB.issuer, jwksUri: asB.jwksUri }],
          audience: GAMMA_AUDIENCE,
        },
        {
          id: "delta",
          backend: "mock",
          issuers: [{ issuer: asA.issuer, jwksUri: asA.jwksUri }],
        },
        {
          id: "epsilon",
          backend: "mock",
          issuers: [{ issuer: asA.issuer, jwksUri: asA.jwksUri }],
          allowedClients: ["agent-app", "other-app"],
        },
      ],
    }),
  );
  fixture = startFixtureServer();
  broker = await startBroker();
});

afterAll(async () => {
  await broker.stop();
  fixture.stop();
  asA.stop();
  asB.stop();
  rmSync(work, { recursive: true, force: true });
});

async function restart() {
  await broker.stop();
  broker = await startBroker();
}

test("each tenant publishes its Protected Resource Metadata", async () => {
  const alpha = await fetch(prmUrl("alpha"));
  expect(alpha.status).toBe(200);
  expect(await alpha.json()).toEqual({
    resource: mcpUrl("alpha"),
    authorization_servers: [asA.issuer],
    scopes_supported: ["sbm:browse", "sbm:fill", "sbm:refs"],
    bearer_methods_supported: ["header"],
    resource_name: "secure-browser-mcp (alpha)",
  });

  const beta = (await (await fetch(prmUrl("beta"))).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(beta.resource).toBe(mcpUrl("beta"));
  expect(beta.authorization_servers).toEqual([asB.issuer]);

  expect((await fetch(prmUrl("nobody"))).status).toBe(404);
  expect((await rpc("nobody", "x", initialize)).status).toBe(404);
});

test("a request without a token gets 401 pointing at the metadata", async () => {
  const res = await rpc("alpha", undefined, initialize);
  expect(res.status).toBe(401);
  const challenge = res.headers.get("www-authenticate")!;
  expect(challenge).toStartWith("Bearer ");
  expect(challenge).toContain(`resource_metadata="${prmUrl("alpha")}"`);
  expect(challenge).toContain(`scope="${ALL}"`);
  expect(challenge).not.toContain("error=");
});

test("expired, wrong-issuer, and wrong-audience tokens get 401", async () => {
  const bad = [
    await asA.mint({ aud: mcpUrl("alpha"), scope: ALL, expiresIn: -120 }),
    // B is a real issuer, but alpha does not trust it.
    await token(asB, "alpha"),
    await asA.mint({ aud: "https://elsewhere.example.com/mcp", scope: ALL }),
    await asA.mint({ aud: base, scope: ALL }),
    "garbage",
  ];
  for (const t of bad) {
    const res = await rpc("alpha", t, initialize);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${prmUrl("alpha")}"`);
  }
});

test("a token for tenant alpha is refused at tenant beta", async () => {
  // beta trusts A, so only the audience tells these apart.
  const res = await rpc("beta", await token(asA, "alpha"), initialize);
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toContain(
    `resource_metadata="${prmUrl("beta")}"`,
  );
  // And A's token minted for beta works there.
  expect((await rpc("beta", await token(asA, "beta"), initialize)).status).toBe(
    200,
  );
});

test("a valid token lists the same tools as the stdio broker", async () => {
  const stdio = new McpStdioClient({ SBM_CHROME_PATH: "/unused" });
  await stdio.initialize();
  const stdioTools = ((await stdio.request("tools/list")).result?.tools ?? [])
    .map((t) => t.name)
    .sort();
  await stdio.stop();

  // Any one sbm scope opens a session, and the list is the full surface.
  const s = await connect(
    "alpha",
    await token(asA, "alpha", { scope: "sbm:browse" }),
  );
  const tools = (await s.client.listTools()).tools.map((t) => t.name).sort();
  expect(tools).toEqual(stdioTools);
  await s.client.close();
});

test("a token without any sbm scope cannot open a session", async () => {
  for (const scope of ["", "openid profile"]) {
    const res = await rpc(
      "alpha",
      await token(asA, "alpha", { scope }),
      initialize,
    );
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    // Only the scope a session needs first, not every scope.
    expect(challenge).toContain('scope="sbm:browse"');
    expect(challenge).toContain(`resource_metadata="${prmUrl("alpha")}"`);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  }
});

test("a malformed Authorization header gets 400 invalid_request", async () => {
  const good = await token(asA, "alpha");
  for (const header of [
    "Bearer",
    "Bearer ",
    `Bearer ${good} extra`,
    "Bearer p@ss:word!",
  ]) {
    const res = await fetch(mcpUrl("alpha"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: header,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...initialize }),
    });
    expect(res.status).toBe(400);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="invalid_request"');
    expect(challenge).toContain(`resource_metadata="${prmUrl("alpha")}"`);
  }

  // Another scheme is no Bearer credentials at all: 401 without an error.
  const basic = await fetch(mcpUrl("alpha"), {
    method: "POST",
    headers: { authorization: "Basic dXNlcjpwYXNz" },
    body: "{}",
  });
  expect(basic.status).toBe(401);
  expect(basic.headers.get("www-authenticate")).not.toContain("error=");
});

test("a tenant's audience override replaces the resource URI", async () => {
  const ok = await asB.mint({ aud: GAMMA_AUDIENCE, scope: ALL });
  expect((await rpc("gamma", ok, initialize)).status).toBe(200);

  // The override is exact: the resource URI itself is no longer accepted,
  // and neither is an aud that also names other audiences.
  for (const aud of [mcpUrl("gamma"), [GAMMA_AUDIENCE, mcpUrl("gamma")]]) {
    const res = await rpc(
      "gamma",
      await asB.mint({ aud, scope: ALL }),
      initialize,
    );
    expect(res.status).toBe(401);
  }

  // The metadata still names the resource URI.
  const prm = (await (await fetch(prmUrl("gamma"))).json()) as {
    resource: string;
  };
  expect(prm.resource).toBe(mcpUrl("gamma"));
});

test("tenant endpoints refuse browser origins that are not allowed", async () => {
  const post = (origin: string) =>
    fetch(mcpUrl("alpha"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        origin,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...initialize }),
    });

  // Refused before auth: no challenge, even without a token.
  const evil = await post("https://evil.example");
  expect(evil.status).toBe(403);
  expect(evil.headers.get("www-authenticate")).toBeNull();
  expect(await evil.text()).toContain("Origin not allowed");

  // An allowed origin goes on to the token check.
  expect((await post(ALLOWED_ORIGIN)).status).toBe(401);

  // The metadata is public: any origin may read it.
  const prm = await fetch(prmUrl("alpha"), {
    headers: { origin: "https://evil.example" },
  });
  expect(prm.status).toBe(200);
  expect(prm.headers.get("access-control-allow-origin")).toBe("*");
});

test("a tool call without its scope gets 403 insufficient_scope", async () => {
  const browseOnly = await token(asA, "alpha", { scope: "sbm:browse" });
  const sessionId = await rawSession("alpha", browseOnly);

  const fill = await rpc(
    "alpha",
    browseOnly,
    {
      method: "tools/call",
      params: {
        name: "fill_secret",
        arguments: { secret_id: "x", element_uid: "y" },
      },
    },
    sessionId,
  );
  expect(fill.status).toBe(403);
  const challenge = fill.headers.get("www-authenticate")!;
  expect(challenge).toContain('error="insufficient_scope"');
  expect(challenge).toContain('scope="sbm:fill"');
  expect(challenge).toContain(`resource_metadata="${prmUrl("alpha")}"`);
  expect(await fill.json()).toMatchObject({ error: "insufficient_scope" });

  const refs = await rpc(
    "alpha",
    browseOnly,
    { method: "tools/call", params: { name: "list_secret_refs" } },
    sessionId,
  );
  expect(refs.status).toBe(403);
  expect(refs.headers.get("www-authenticate")).toContain('scope="sbm:refs"');

  // A batch that needs two missing scopes names both in one challenge.
  const batch = await fetch(mcpUrl("alpha"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
      authorization: `Bearer ${browseOnly}`,
    },
    body: JSON.stringify([
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "fill_secret",
          arguments: { secret_id: "x", element_uid: "y" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_secret_refs" },
      },
    ]),
  });
  expect(batch.status).toBe(403);
  expect(batch.headers.get("www-authenticate")).toContain(
    'scope="sbm:fill sbm:refs"',
  );

  // The scope it has works.
  const snap = await rpc(
    "alpha",
    browseOnly,
    { method: "tools/call", params: { name: "snapshot", arguments: {} } },
    sessionId,
  );
  expect(snap.status).toBe(200);
}, 30_000);

test("a session answers only to the tenant and subject that opened it", async () => {
  const alice = await token(asA, "alpha", { sub: "alice" });
  const sessionId = await rawSession("alpha", alice);
  const list = { method: "tools/list" };

  expect((await rpc("alpha", alice, list, sessionId)).status).toBe(200);
  const bob = await token(asA, "alpha", { sub: "bob" });
  expect((await rpc("alpha", bob, list, sessionId)).status).toBe(404);
  const betaAlice = await token(asA, "beta", { sub: "alice" });
  expect((await rpc("beta", betaAlice, list, sessionId)).status).toBe(404);
});

test("a session answers only to the OAuth client that opened it", async () => {
  const withClient = (claims: Record<string, unknown>) =>
    token(asA, "delta", { sub: "carol", claims });
  const sessionId = await rawSession(
    "delta",
    await withClient({ azp: "app-1" }),
  );
  const list = { method: "tools/list" };

  // The same client, by azp or client_id, is the same caller.
  for (const claims of [{ azp: "app-1" }, { client_id: "app-1" }]) {
    expect(
      (await rpc("delta", await withClient(claims), list, sessionId)).status,
    ).toBe(200);
  }
  // Another client of the same subject, or a token that names no client,
  // does not see the session.
  for (const claims of [{ azp: "app-2" }, { client_id: "app-2" }, {}]) {
    expect(
      (await rpc("delta", await withClient(claims), list, sessionId)).status,
    ).toBe(404);
  }
});

test("a tenant with allowedClients refuses tokens of other clients", async () => {
  const withClient = (claims: Record<string, unknown>) =>
    token(asA, "epsilon", { claims });
  for (const claims of [{ azp: "agent-app" }, { client_id: "other-app" }]) {
    expect(
      (await rpc("epsilon", await withClient(claims), initialize)).status,
    ).toBe(200);
  }
  for (const claims of [{}, { azp: "rogue-app" }, { client_id: "rogue" }]) {
    const res = await rpc("epsilon", await withClient(claims), initialize);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  }
});

test("tenants see only their own secrets and fills, across a restart", async () => {
  const aliceToken = await token(asA, "alpha", { sub: "alice" });
  const alpha = await connect("alpha", aliceToken);
  const beta = await connect("beta", await token(asB, "beta", { sub: "eve" }));

  expect(await refNames(alpha)).toContain("demo-login-password");
  expect(await refNames(beta)).toEqual(["beta-login-password"]);

  const refs = (await alpha.call("list_secret_refs")).body.refs;
  const secretId = refs.find(
    (r: { name: string }) => r.name === "demo-login-password",
  ).secretId;
  const parked = (
    await alpha.call("fill_secret", {
      secret_id: secretId,
      element_uid: await openLogin(alpha),
    })
  ).body;
  expect(parked.status).toBe("pending_approval");

  // Parked under alpha's directory only.
  const fills = (t: string) => {
    const dir = join(stateDir, "tenants", t);
    return existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".fill"))
      : [];
  };
  expect(fills("alpha").length).toBe(1);
  expect(fills("beta")).toEqual([]);

  const steal = async (s: Session) => {
    const r = await s.call("await_fill", {
      fill_id: parked.fill_id,
      element_uid: "e1",
      timeout_seconds: 1,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Unknown fill_id");
  };
  await steal(beta);

  await alpha.client.close().catch(() => {});
  await beta.client.close().catch(() => {});
  await restart();

  // After the restart every fill is an orphan. beta still cannot claim
  // alpha's, and neither can another subject of alpha.
  const betaAfter = await connect("beta", await token(asB, "beta"));
  await steal(betaAfter);
  expect(await refNames(betaAfter)).toEqual(["beta-login-password"]);
  const bob = await connect("alpha", await token(asA, "alpha", { sub: "bob" }));
  await steal(bob);

  // The subject that parked it can claim it from a new session.
  const aliceAfter = await connect(
    "alpha",
    await token(asA, "alpha", { sub: "alice" }),
  );
  const done = await aliceAfter.call("await_fill", {
    fill_id: parked.fill_id,
    element_uid: await openLogin(aliceAfter),
    timeout_seconds: 10,
  });
  expect(done.body).toMatchObject({ filled: true, secret_id: secretId });
  expect(fills("alpha")).toEqual([]);

  for (const s of [betaAfter, bob, aliceAfter]) await s.client.close();
}, 90_000);

test("a client-credentials token with scp scopes can use the tools", async () => {
  // No scope claim: only scp, as Okta issues it.
  const machine = await asA.mint({
    aud: mcpUrl("alpha"),
    sub: "svc-agent@clients",
    scp: ["sbm:browse", "sbm:refs"],
  });
  const sessionId = await rawSession("alpha", machine);

  const refs = await rpc(
    "alpha",
    machine,
    { method: "tools/call", params: { name: "list_secret_refs" } },
    sessionId,
  );
  expect(refs.status).toBe(200);

  // The scp claim limits the client like scope does.
  const fill = await rpc(
    "alpha",
    machine,
    {
      method: "tools/call",
      params: {
        name: "fill_secret",
        arguments: { secret_id: "x", element_uid: "y" },
      },
    },
    sessionId,
  );
  expect(fill.status).toBe(403);
  expect(fill.headers.get("www-authenticate")).toContain('scope="sbm:fill"');
}, 30_000);

test("a request id in flight cannot be reused in the session", async () => {
  // Two tokens of one subject share a session: one may list secret refs,
  // the other may only browse.
  const refsToken = await token(asA, "delta", { sub: "dana" });
  const browseOnly = await token(asA, "delta", {
    sub: "dana",
    scope: "sbm:browse",
  });
  const sessionId = await rawSession("delta", refsToken);
  const listRefs = {
    id: 7,
    method: "tools/call",
    params: { name: "list_secret_refs" },
  };
  const navigate = (url: string) => ({
    id: 7,
    method: "tools/call",
    params: { name: "navigate", arguments: { url } },
  });
  // A page that loads slower than list_secret_refs answers, so the
  // browse-only call is still open when the refs result is sent.
  const slowPage = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async () => {
      await Bun.sleep(LIST_DELAY_MS * 2);
      return new Response("<title>slow</title>", {
        headers: { "content-type": "text/html" },
      });
    },
  });

  // The browse-only call reuses the id while list_secret_refs is in
  // flight. If the broker forwarded it, the transport would send the refs
  // result on the browse-only call's stream.
  const slow = rpc("delta", refsToken, listRefs, sessionId);
  await Bun.sleep(LIST_DELAY_MS / 5);
  const dup = await rpc(
    "delta",
    browseOnly,
    navigate(`http://127.0.0.1:${slowPage.port}/`),
    sessionId,
  ).finally(() => slowPage.stop(true));
  const dupText = await dup.text();
  expect(dup.status).toBe(409);
  expect(dupText).not.toContain("demo-login-password");
  expect(JSON.parse(dupText)).toMatchObject({
    error: { code: -32600 },
    id: null,
  });

  const first = await slow;
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("demo-login-password");

  // The id is free once the call is done.
  const again = await rpc(
    "delta",
    browseOnly,
    navigate(`${FIXTURE_ORIGIN}/login`),
    sessionId,
  );
  expect(again.status).toBe(200);
  expect(await again.text()).not.toContain("demo-login-password");

  // Each request still gets the scopes of its own token.
  expect((await rpc("delta", browseOnly, listRefs, sessionId)).status).toBe(
    403,
  );
  const stepUp = await rpc("delta", refsToken, listRefs, sessionId);
  expect(stepUp.status).toBe(200);
  expect(await stepUp.text()).toContain("demo-login-password");

  // One id twice in a batch is refused too, and forwards neither.
  const batch = await rpc(
    "delta",
    refsToken,
    [
      { jsonrpc: "2.0", ...listRefs, id: 8 },
      { jsonrpc: "2.0", id: 8, method: "tools/list" },
    ],
    sessionId,
  );
  expect(batch.status).toBe(409);
  expect(await batch.text()).not.toContain("demo-login-password");
  // Notifications carry no id and are never refused.
  const note = await rpc(
    "delta",
    refsToken,
    [{ jsonrpc: "2.0", method: "notifications/initialized" }],
    sessionId,
  );
  expect(note.status).toBe(202);
}, 30_000);

test("a GET stream ends when its token expires", async () => {
  const long = await token(asA, "delta", { sub: "erin" });
  const sessionId = await rawSession("delta", long);
  const get = (bearer: string) =>
    fetch(mcpUrl("delta"), {
      headers: {
        accept: "text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        "mcp-session-id": sessionId,
        authorization: `Bearer ${bearer}`,
      },
    });

  const short = await asA.mint({
    aud: mcpUrl("delta"),
    sub: "erin",
    scope: ALL,
    expiresIn: 2,
  });
  const started = Date.now();
  const stream = await get(short);
  expect(stream.status).toBe(200);
  expect(stream.headers.get("content-type")).toContain("text/event-stream");
  // Read until the broker ends the stream; the test timeout catches a
  // stream that never ends.
  const reader = stream.body!.getReader();
  while (!(await reader.read()).done);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThan(1_000);
  expect(elapsed).toBeLessThan(5_000);

  // The session's one GET stream is free again, for a fresh token.
  const again = await get(long);
  expect(again.status).toBe(200);
  await again.body?.cancel();
}, 15_000);

test("one principal or tenant cannot take every session slot", async () => {
  /** Open sessions until refused; returns how many opened, and the
   * refusal. */
  const fill = async (bearer: string) => {
    let opened = 0;
    let res: Response;
    while ((res = await rpc("beta", bearer, initialize)).status === 200) {
      opened++;
      expect(opened).toBeLessThanOrEqual(5);
    }
    expect(res.status).toBe(503);
    return { opened, refusal: await res.text() };
  };

  // 25 slots and 5 tenants: beta gets at most 5, and one principal at most
  // 4 of them. An earlier test may still hold a beta session.
  const greedy = await fill(await token(asB, "beta", { sub: "greedy" }));
  expect(greedy.opened).toBe(4);
  expect(greedy.refusal).toContain("caller is at its session limit");
  // A principal is (iss, sub): the same subject from another issuer that
  // beta trusts is another principal.
  const next = await fill(await token(asA, "beta", { sub: "greedy" }));
  expect(next.opened).toBeLessThanOrEqual(1);
  expect(next.refusal).toContain("tenant is at its session limit");

  expect(
    (await rpc("alpha", await token(asA, "alpha"), initialize)).status,
  ).toBe(200);
});

test("the plaintext never appeared in any HTTP response", () => {
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript).not.toContain(DEMO_PLAINTEXT);
  expect(transcript).not.toContain(BETA_PLAINTEXT);
});
