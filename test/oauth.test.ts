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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

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
 */

const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed
const BETA_PLAINTEXT = "beta-only-plaintext-0000";
const ALL = "sbm:browse sbm:fill sbm:refs";

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
  opts: { sub?: string; scope?: string } = {},
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
    }) as Transport,
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

/** One raw JSON-RPC POST, for status codes and headers the SDK hides. */
async function rpc(
  tenant: string,
  bearer: string | undefined,
  message: object,
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
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...message }),
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

  // Listing needs no particular scope.
  const s = await connect("alpha", await token(asA, "alpha", { scope: "" }));
  const tools = (await s.client.listTools()).tools.map((t) => t.name).sort();
  expect(tools).toEqual(stdioTools);
  await s.client.close();
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

test("the plaintext never appeared in any HTTP response", () => {
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript).not.toContain(DEMO_PLAINTEXT);
  expect(transcript).not.toContain(BETA_PLAINTEXT);
});
