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
import { MockAuthServer } from "./mock-auth-server.js";

/**
 * The hosted broker as an OAuth resource server, black box: EMG-89 step 2
 * acceptance.
 *
 *  - alpha trusts authorization server A and holds the default mock
 *    secrets, with demo-login-password behind consensus.
 *  - beta trusts B and A, and holds one secret of its own. Trusting A means
 *    a token A minted for alpha fails at beta on audience alone.
 *  - gamma trusts B and sets an `audience` override.
 *  - delta trusts A, for tests that need sessions of their own. Listing its
 *    secrets takes LIST_DELAY_MS.
 *  - epsilon trusts A and sets allowedClients.
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
      // Every tenant here uses the mock backend, which needs the dev flag.
      SBM_DEV_SHARED_TOKEN: "1",
      SBM_HEADLESS: "true",
      SBM_TENANTS: tenantsFile,
      SBM_PUBLIC_URL: base,
      SBM_HTTP_PORT: String(port),
      SBM_STATE_DIR: stateDir,
      SBM_STATE_KEY: stateKey,
      // Five tenants get five slots each, and a principal the default four.
      SBM_MAX_SESSIONS: "25",
      SBM_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
      SBM_MOCK_CONSENSUS: "demo-login-password",
      SBM_MOCK_CONSENSUS_DELAY_MS: "2000",
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
  headers: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(mcpUrl(tenant), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...headers,
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
const toolCall = (name: string, args: object = {}, id = 1) => ({
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
const fillCall = toolCall("fill_secret", { secret_id: "x", element_uid: "y" });

/** Open a session over raw HTTP; returns its id. */
async function rawSession(tenant: string, bearer: string): Promise<string> {
  const res = await rpc(tenant, bearer, initialize);
  expect(res.status).toBe(200);
  const id = res.headers.get("mcp-session-id")!;
  const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
  await rpc(tenant, bearer, [initialized], id);
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
  const a = { issuer: asA.issuer, jwksUri: asA.jwksUri };
  const b = { issuer: asB.issuer, jwksUri: asB.jwksUri };
  writeFileSync(
    tenantsFile,
    JSON.stringify({
      tenants: [
        { id: "alpha", backend: "mock", issuers: [a] },
        {
          id: "beta",
          backend: "mock",
          issuers: [b, a],
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
          issuers: [b],
          audience: GAMMA_AUDIENCE,
        },
        {
          id: "delta",
          backend: "mock",
          issuers: [a],
          listDelayMs: LIST_DELAY_MS,
        },
        {
          id: "epsilon",
          backend: "mock",
          issuers: [a],
          allowedClients: ["agent-app"],
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

test("a mock tenant stops the broker at startup without the dev flag", async () => {
  const proc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      SBM_HTTP_TOKEN: "",
      SBM_DEV_SHARED_TOKEN: "",
      SBM_TENANTS: tenantsFile,
      SBM_PUBLIC_URL: base,
      SBM_HTTP_PORT: String(port + 1),
    },
  });
  const guard = setTimeout(() => proc.kill(), 10_000);
  expect(await proc.exited).not.toBe(0);
  clearTimeout(guard);
  expect(await new Response(proc.stderr).text()).toContain(
    "Tenant alpha uses the mock secrets backend",
  );
});

test("each tenant publishes its Protected Resource Metadata", async () => {
  // Public: any origin may read it.
  const alpha = await fetch(prmUrl("alpha"), {
    headers: { origin: "https://evil.example" },
  });
  expect(alpha.status).toBe(200);
  expect(alpha.headers.get("access-control-allow-origin")).toBe("*");
  expect(await alpha.json()).toEqual({
    resource: mcpUrl("alpha"),
    authorization_servers: [asA.issuer],
    scopes_supported: ["sbm:browse", "sbm:fill", "sbm:refs"],
    bearer_methods_supported: ["header"],
    resource_name: "secure-browser-mcp (alpha)",
  });
  const beta = (await (await fetch(prmUrl("beta"))).json()) as {
    authorization_servers: string[];
  };
  expect(beta.authorization_servers).toEqual([asB.issuer]);

  expect((await fetch(prmUrl("nobody"))).status).toBe(404);
  expect((await rpc("nobody", "x", initialize)).status).toBe(404);
});

test("missing, malformed, and invalid credentials are refused with a challenge", async () => {
  const good = await token(asA, "alpha");
  const cases: [string | undefined, number, string | undefined][] = [
    [undefined, 401, undefined],
    // Another scheme is no Bearer credentials at all.
    ["Basic dXNlcjpwYXNz", 401, undefined],
    ["Bearer", 400, "invalid_request"],
    ["Bearer ", 400, "invalid_request"],
    [`Bearer ${good} extra`, 400, "invalid_request"],
    ["Bearer p@ss:word!", 400, "invalid_request"],
    ["Bearer garbage", 401, "invalid_token"],
    // B is a real issuer, but alpha does not trust it.
    [`Bearer ${await token(asB, "alpha")}`, 401, "invalid_token"],
  ];
  for (const [authorization, status, error] of cases) {
    const res = await rpc(
      "alpha",
      undefined,
      initialize,
      undefined,
      authorization ? { authorization } : {},
    );
    expect(res.status).toBe(status);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toStartWith("Bearer ");
    if (error) expect(challenge).toContain(`error="${error}"`);
    else expect(challenge).not.toContain("error=");
    expect(challenge).toContain(`scope="${ALL}"`);
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
  expect((await rpc("beta", await token(asA, "beta"), initialize)).status).toBe(
    200,
  );
});

test("a tenant's audience override replaces the resource URI", async () => {
  const ok = await asB.mint({ aud: GAMMA_AUDIENCE, scope: ALL });
  expect((await rpc("gamma", ok, initialize)).status).toBe(200);
  // The resource URI itself is no longer accepted, nor an extra audience.
  for (const aud of [mcpUrl("gamma"), [GAMMA_AUDIENCE, mcpUrl("gamma")]]) {
    const bad = await asB.mint({ aud, scope: ALL });
    expect((await rpc("gamma", bad, initialize)).status).toBe(401);
  }
  // With an override, typ: at+jwt is required by default: an ID token for
  // a client whose id is the override, without nonce, at_hash, or c_hash,
  // differs from an access token only by typ.
  for (const typ of ["JWT", null]) {
    const idShaped = await asB.mint({ aud: GAMMA_AUDIENCE, scope: ALL, typ });
    expect((await rpc("gamma", idShaped, initialize)).status).toBe(401);
  }
});

test("tenant endpoints refuse browser origins that are not allowed", async () => {
  // Refused before auth: no challenge, even without a token.
  const evil = await rpc("alpha", undefined, initialize, undefined, {
    origin: "https://evil.example",
  });
  expect(evil.status).toBe(403);
  expect(evil.headers.get("www-authenticate")).toBeNull();
  expect(await evil.text()).toContain("Origin not allowed");

  // An allowed origin goes on to the token check.
  const allowed = await rpc("alpha", undefined, initialize, undefined, {
    origin: ALLOWED_ORIGIN,
  });
  expect(allowed.status).toBe(401);
});

test("a token without any sbm scope cannot open a session", async () => {
  const res = await rpc(
    "alpha",
    await token(asA, "alpha", { scope: "openid profile" }),
    initialize,
  );
  expect(res.status).toBe(403);
  const challenge = res.headers.get("www-authenticate")!;
  expect(challenge).toContain('error="insufficient_scope"');
  expect(challenge).toContain('scope="sbm:browse"');
  expect(challenge).toContain(`resource_metadata="${prmUrl("alpha")}"`);
  expect(res.headers.get("mcp-session-id")).toBeNull();
});

test("a tool call without its scope gets 403 insufficient_scope", async () => {
  const browseOnly = await token(asA, "alpha", { scope: "sbm:browse" });
  const sessionId = await rawSession("alpha", browseOnly);

  const fill = await rpc("alpha", browseOnly, fillCall, sessionId);
  expect(fill.status).toBe(403);
  const challenge = fill.headers.get("www-authenticate")!;
  expect(challenge).toContain('error="insufficient_scope"');
  expect(challenge).toContain('scope="sbm:fill"');
  expect(challenge).toContain(`resource_metadata="${prmUrl("alpha")}"`);

  // A batch names every missing scope in one challenge.
  const batch = await rpc(
    "alpha",
    browseOnly,
    [
      { jsonrpc: "2.0", ...fillCall, id: 2 },
      { jsonrpc: "2.0", ...toolCall("list_secret_refs"), id: 3 },
    ],
    sessionId,
  );
  expect(batch.status).toBe(403);
  expect(batch.headers.get("www-authenticate")).toContain(
    'scope="sbm:fill sbm:refs"',
  );
});

test("a session answers only to the tenant, subject, and client that opened it", async () => {
  const carol = (
    tenant: string,
    claims: Record<string, unknown>,
    sub = "carol",
  ) => token(asA, tenant, { sub, claims });
  const sessionId = await rawSession(
    "delta",
    await carol("delta", { azp: "app-1" }),
  );
  const list = { method: "tools/list" };
  const cases: [string, string, number][] = [
    // The same client, by azp or client_id, is the same caller.
    ["delta", await carol("delta", { azp: "app-1" }), 200],
    ["delta", await carol("delta", { client_id: "app-1" }), 200],
    ["delta", await carol("delta", { azp: "app-1" }, "bob"), 404],
    ["alpha", await carol("alpha", { azp: "app-1" }), 404],
    ["delta", await carol("delta", { azp: "app-2" }), 404],
    ["delta", await carol("delta", {}), 404],
  ];
  for (const [tenant, bearer, status] of cases) {
    expect((await rpc(tenant, bearer, list, sessionId)).status).toBe(status);
  }
});

test("tokens of one subject with different clients cannot share a session", async () => {
  const frank = (claims: Record<string, unknown>) =>
    token(asA, "delta", { sub: "frank", claims });
  const list = { method: "tools/list" };
  const appA = await rawSession("delta", await frank({ azp: "app-a" }));
  expect(
    (await rpc("delta", await frank({ azp: "app-b" }), list, appA)).status,
  ).toBe(404);
  const appB = await rawSession("delta", await frank({ azp: "app-b" }));
  expect(
    (await rpc("delta", await frank({ azp: "app-a" }), list, appB)).status,
  ).toBe(404);
});

test("a session opened without a client claim is bound to the tenant and subject only", async () => {
  const gina = (claims: Record<string, unknown>, sub = "gina") =>
    token(asA, "delta", { sub, claims });
  const sessionId = await rawSession("delta", await gina({}));
  const list = { method: "tools/list" };
  const cases: [string, number][] = [
    // Any token of the subject without a client claim: the broker cannot
    // tell those clients apart (docs/HOSTED.md, "Sessions").
    [await gina({}), 200],
    [await gina({ azp: "" }), 200],
    // A token that names a client, or another subject, cannot.
    [await gina({ azp: "app-1" }), 404],
    [await gina({ client_id: "app-1" }), 404],
    [await gina({}, "hank"), 404],
  ];
  for (const [bearer, status] of cases) {
    expect((await rpc("delta", bearer, list, sessionId)).status).toBe(status);
  }
});

test("a tenant with allowedClients refuses tokens of other clients", async () => {
  const withClient = async (claims: Record<string, unknown>) =>
    (await rpc("epsilon", await token(asA, "epsilon", { claims }), initialize))
      .status;
  expect(await withClient({ azp: "agent-app" })).toBe(200);
  expect(await withClient({ azp: "rogue-app" })).toBe(401);
  expect(await withClient({})).toBe(401);
});

test("tenants see only their own secrets and fills, across a restart", async () => {
  const alpha = await connect(
    "alpha",
    await token(asA, "alpha", { sub: "alice" }),
  );
  const beta = await connect("beta", await token(asB, "beta", { sub: "eve" }));
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
  await broker.stop();
  broker = await startBroker();

  // After the restart every fill is an orphan. Neither beta nor another
  // subject of alpha can claim alice's.
  const betaAfter = await connect("beta", await token(asB, "beta"));
  await steal(betaAfter);
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

test("a request id in flight cannot be reused in the session", async () => {
  // Two tokens of one subject share a session: one may list secret refs,
  // the other may only browse.
  const refsToken = await token(asA, "delta", { sub: "dana" });
  const browseOnly = await token(asA, "delta", {
    sub: "dana",
    scope: "sbm:browse",
  });
  const sessionId = await rawSession("delta", refsToken);
  const listRefs = toolCall("list_secret_refs", {}, 7);
  const navigate = (url: string) => toolCall("navigate", { url }, 7);
  // A page slower than list_secret_refs, so the browse-only call would
  // still be open when the refs result is sent.
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

  // If the broker forwarded the reused id, the transport would send the
  // refs result on the browse-only call's stream.
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
  // Each request still gets the scopes of its own token.
  expect((await rpc("delta", browseOnly, listRefs, sessionId)).status).toBe(
    403,
  );
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

  // beta gets 5 slots, and one principal 4 of them. An earlier test may
  // still hold a beta session.
  const greedy = await fill(await token(asB, "beta", { sub: "greedy" }));
  expect(greedy.opened).toBe(4);
  expect(greedy.refusal).toContain("caller is at its session limit");
  // A principal is (iss, sub): the same sub from another issuer is another.
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
