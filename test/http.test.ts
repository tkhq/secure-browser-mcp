import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { FIXTURE_ORIGIN, startFixtureServer } from "./fixtures/serve.js";
import { McpStdioClient } from "./mcp-client.js";

/**
 * The hosted broker (src/http.ts), black box, in its development
 * shared-token mode (SBM_DEV_SHARED_TOKEN): EMG-89 step 1 acceptance. Same
 * tools as stdio, sessions isolated from each other, and a pending fill
 * that survives a broker restart. Both protocol eras, with browser handles
 * (EMG-288). Tenant OAuth is in oauth.test.ts.
 */

const TOKEN = "test-token";
const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed
const CARD_NUMBER = "4242424242424242"; // mock-secrets.ts demo-card seed
const stateDir = mkdtempSync(join(tmpdir(), "sbm-state-"));
const stateKey = randomBytes(32).toString("hex");
/** Where the dev endpoint's parked fills live under SBM_STATE_DIR. */
const fillDir = join(stateDir, "tenants", "_shared-token");
const port = 18_000 + Math.floor(Math.random() * 2_000);
const url = `http://127.0.0.1:${port}/mcp`;

/** Every response body the server sent, for leak assertions. */
let transcript = "";
let fixture: { stop: () => void };
let broker: BrokerProcess;

type BrokerProcess = { stop: () => Promise<void> };

async function startBroker(
  env: Record<string, string> = {},
): Promise<BrokerProcess> {
  const proc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      TURNKEY_API_PUBLIC_KEY: "",
      TURNKEY_API_PRIVATE_KEY: "",
      TURNKEY_ORGANIZATION_ID: "",
      SBM_HEADLESS: "true",
      SBM_HTTP_TOKEN: TOKEN,
      SBM_DEV_SHARED_TOKEN: "1",
      SBM_HTTP_PORT: String(port),
      SBM_STATE_DIR: stateDir,
      SBM_STATE_KEY: stateKey,
      SBM_MOCK_CONSENSUS: "demo-login-password,demo-card",
      SBM_MOCK_CONSENSUS_DELAY_MS: "2000",
      SBM_ALLOWED_ORIGINS: "https://allowed.example, http://localhost:3000",
      ...env,
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

type Session = {
  client: Client;
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ isError: boolean; body: any; text: string }>;
};

/** A 2025-era session, or with `modern` a client pinned to 2026-07-28. */
async function connect(
  opts: { modern?: boolean; url?: string } = {},
): Promise<Session> {
  const client = new Client(
    { name: "http-test", version: "0" },
    opts.modern
      ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
      : undefined,
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(opts.url ?? url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
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

async function openLogin(s: Session, browser: Record<string, string> = {}) {
  await s.call("navigate", { url: `${FIXTURE_ORIGIN}/login`, ...browser });
  const snap = (await s.call("snapshot", browser)).body;
  return snap.elements.find((e: { type?: string }) => e.type === "password")
    .uid as string;
}

async function demoSecretId(s: Session): Promise<string> {
  const refs = (await s.call("list_secret_refs")).body.refs;
  return refs.find((r: { name?: string }) => r.name === "demo-login-password")
    .secretId;
}

beforeAll(async () => {
  fixture = startFixtureServer();
  broker = await startBroker();
});

afterAll(async () => {
  await broker.stop();
  fixture.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

test("the shared token needs the dev flag and a header-safe value", async () => {
  for (const [env, message] of [
    [
      { SBM_HTTP_TOKEN: TOKEN, SBM_DEV_SHARED_TOKEN: "" },
      "SBM_DEV_SHARED_TOKEN",
    ],
    [
      { SBM_HTTP_TOKEN: "p@ss:word!", SBM_DEV_SHARED_TOKEN: "1" },
      "SBM_HTTP_TOKEN may contain only",
    ],
  ] as const) {
    const proc = Bun.spawn(["bun", "src/http.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    const guard = setTimeout(() => proc.kill(), 10_000);
    expect(await proc.exited).not.toBe(0);
    clearTimeout(guard);
    expect(await new Response(proc.stderr).text()).toContain(message);
  }
});

test("requests without the bearer token are refused", async () => {
  const res = await fetch(url, { method: "POST", body: "{}" });
  expect(res.status).toBe(401);
  const wrong = await fetch(url, {
    method: "POST",
    headers: { authorization: "Bearer nope" },
    body: "{}",
  });
  expect(wrong.status).toBe(401);
});

function initializeRequest(headers: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "origin-test", version: "0" },
      },
    }),
  };
}

/** Initialize over raw HTTP, then DELETE the session it opened. */
async function initializeAndClose(headers: Record<string, string>) {
  const res = await fetch(url, initializeRequest(headers));
  const sessionId = res.headers.get("mcp-session-id");
  await res.text();
  if (sessionId) {
    await fetch(url, {
      method: "DELETE",
      headers: { ...headers, "mcp-session-id": sessionId },
    });
  }
  return { status: res.status, sessionId };
}

test("a request from a disallowed Origin gets 403 before auth", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  for (const origin of [
    "https://evil.example",
    "null",
    "https://allowed.example.evil.example",
    "http://allowed.example", // scheme differs
    "http://localhost:4000", // port differs
  ]) {
    const res = await fetch(url, initializeRequest({ ...auth, origin }));
    expect(res.status).toBe(403);
    expect(res.headers.get("mcp-session-id")).toBeNull();
    expect(((await res.json()) as any).error.message).toBe(
      "Origin not allowed",
    );
  }
  // No token either: the Origin check answers first.
  const noAuth = await fetch(
    url,
    initializeRequest({ origin: "https://evil.example" }),
  );
  expect(noAuth.status).toBe(403);
});

test("allowed Origins and requests without Origin are served", async () => {
  const auth = { authorization: `Bearer ${TOKEN}` };
  for (const headers of [
    auth,
    { ...auth, origin: "https://allowed.example" },
    { ...auth, origin: "http://localhost:3000" },
  ]) {
    const { status, sessionId } = await initializeAndClose(headers);
    expect(status).toBe(200);
    expect(sessionId).toBeString();
  }
  // An allowed Origin does not replace the bearer token.
  const res = await fetch(
    url,
    initializeRequest({ origin: "https://allowed.example" }),
  );
  expect(res.status).toBe(401);
});

/** A 2026-07-28 request: no session, `_meta` envelope on the request. */
function modernDiscover(): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "server/discover",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "probe", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  };
}

test("a raw 2026-07-28 request is served without a session", async () => {
  const res = await fetch(url, modernDiscover());
  expect(res.status).toBe(200);
  expect(res.headers.get("mcp-session-id")).toBeNull();
  const body = (await res.json()) as any;
  expect(body.id).toBe(7);
  expect(body.result.supportedVersions).toContain("2026-07-28");
});

test("a client in auto mode now picks 2026-07-28", async () => {
  const auto = new Client(
    { name: "auto", version: "0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await auto.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    }),
  );
  expect(auto.getProtocolEra()).toBe("modern");
  await auto.close();
});

test("a 2026-07-28 client lists refs, navigates, fills, and resumes a parked fill by browser_id", async () => {
  const s = await connect({ modern: true });
  expect(s.client.getProtocolEra()).toBe("modern");
  const tools = (await s.client.listTools()).tools;
  const navigateTool = tools.find((t) => t.name === "navigate")!;
  expect(Object.keys(navigateTool.inputSchema.properties ?? {})).toContain(
    "browser_id",
  );

  // There is no session, so a browser tool must name a browser.
  const bare = await s.call("snapshot");
  expect(bare.isError).toBe(true);
  expect(bare.text).toContain("open_browser");

  const secretId = await demoSecretId(s);
  const { browser_id } = (await s.call("open_browser")).body;
  expect(browser_id).toMatch(/^br_[A-Za-z0-9_-]{32}$/);
  const uid = await openLogin(s, { browser_id });

  const parked = (
    await s.call("fill_secret", {
      secret_id: secretId,
      element_uid: uid,
      browser_id,
    })
  ).body;
  expect(parked.status).toBe("pending_approval");
  // The fill is parked on the browser, not on the request: another
  // browser of the same caller cannot take it while this one is open.
  const other = (await s.call("open_browser")).body.browser_id;
  const stolen = await s.call("await_fill", {
    fill_id: parked.fill_id,
    timeout_seconds: 1,
    browser_id: other,
  });
  expect(stolen.text).toContain("Unknown fill_id");
  await s.call("close_browser", { browser_id: other });

  const done = await s.call("await_fill", {
    fill_id: parked.fill_id,
    timeout_seconds: 10,
    browser_id,
  });
  expect(done.body).toMatchObject({ filled: true, secret_id: secretId });
  const snap = (await s.call("snapshot", { browser_id })).body;
  const filled = snap.elements.find((e: { uid: string }) => e.uid === uid);
  expect(filled?.value).toBe("[REDACTED:secret-filled-field]");

  expect((await s.call("close_browser", { browser_id })).body).toEqual({
    closed: browser_id,
  });
  const gone = await s.call("snapshot", { browser_id });
  expect(gone.isError).toBe(true);
  expect(gone.text).toContain("Unknown browser_id");
  await s.client.close();
}, 60_000);

test("a 2025 client with a new session per call keeps one browser_id (the Arcade pattern)", async () => {
  // Every call opens a session and never closes it. More calls than the
  // endpoint has session slots: idle, browserless sessions make room.
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await connect()).call(name, args);

  const { browser_id } = (await call("open_browser")).body;
  const secretId = (await call("list_secret_refs")).body.refs.find(
    (r: { name?: string }) => r.name === "demo-login-password",
  ).secretId;
  await call("navigate", { url: `${FIXTURE_ORIGIN}/login`, browser_id });
  const snap = (await call("snapshot", { browser_id })).body;
  expect(snap.url).toContain("/login");
  const uid = snap.elements.find(
    (e: { type?: string }) => e.type === "password",
  ).uid;
  // A session's own browser is still its own.
  expect((await call("snapshot")).body.url).not.toContain("/login");

  const parked = (
    await call("fill_secret", {
      secret_id: secretId,
      element_uid: uid,
      browser_id,
    })
  ).body;
  expect(parked.status).toBe("pending_approval");
  for (let i = 0; i < 6; i++) {
    expect((await call("snapshot", { browser_id })).body.url).toContain(
      "/login",
    );
  }
  const done = await call("await_fill", {
    fill_id: parked.fill_id,
    timeout_seconds: 10,
    browser_id,
  });
  expect(done.body).toMatchObject({ filled: true, secret_id: secretId });
  const after = (await call("snapshot", { browser_id })).body;
  const filled = after.elements.find((e: { uid: string }) => e.uid === uid);
  expect(filled?.value).toBe("[REDACTED:secret-filled-field]");
  expect((await call("close_browser", { browser_id })).isError).toBe(false);
}, 90_000);

test("an idle browser handle is closed after SBM_SESSION_IDLE_S", async () => {
  const idlePort = port + 1;
  const idleUrl = `http://127.0.0.1:${idlePort}/mcp`;
  const idle = await startBroker({
    SBM_HTTP_PORT: String(idlePort),
    SBM_SESSION_IDLE_S: "1",
    SBM_STATE_DIR: "",
  });
  try {
    const s = await connect({ modern: true, url: idleUrl });
    const { browser_id } = (await s.call("open_browser")).body;
    expect((await s.call("open_browser")).body.idle_timeout_seconds).toBe(1);
    await s.call("navigate", { url: `${FIXTURE_ORIGIN}/login`, browser_id });
    await new Promise((r) => setTimeout(r, 3_000));
    const gone = await s.call("snapshot", { browser_id });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain("Unknown browser_id");
    await s.client.close();
  } finally {
    await idle.stop();
  }
}, 30_000);

test("DELETE ends the session", async () => {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "delete-test", version: "0" });
  await client.connect(transport);
  const id = transport.sessionId;
  expect(id).toBeString();
  await transport.terminateSession();

  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": id!,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(res.status).toBe(404);
  await client.close();
});

test("lists the same tools as the stdio broker", async () => {
  const stdio = new McpStdioClient({ SBM_CHROME_PATH: "/unused" });
  await stdio.initialize();
  const stdioTools = ((await stdio.request("tools/list")).result?.tools ?? [])
    .map((t) => t.name)
    .sort();
  await stdio.stop();

  const s = await connect();
  const httpTools = (await s.client.listTools()).tools.map((t) => t.name);
  expect(httpTools.sort()).toEqual(stdioTools);
  expect(httpTools).toContain("fill_secret");
  await s.client.close();
});

test("two sessions see neither each other's browser nor pending fills", async () => {
  const a = await connect();
  const b = await connect();
  const secretId = await demoSecretId(a);

  const uid = await openLogin(a);
  const parked = (
    await a.call("fill_secret", {
      secret_id: secretId,
      element_uid: uid,
    })
  ).body;
  expect(parked.status).toBe("pending_approval");

  // B has its own browser: A's navigation is not visible there.
  const bSnap = (await b.call("snapshot")).body;
  expect(bSnap.url).not.toContain("/login");

  // B cannot redeem A's fill while A's session is alive.
  const stolen = await b.call("await_fill", {
    fill_id: parked.fill_id,
    timeout_seconds: 5,
  });
  expect(stolen.isError).toBe(true);
  expect(stolen.text).toContain("Unknown fill_id");

  // A completes its own fill.
  const done = await a.call("await_fill", {
    fill_id: parked.fill_id,
    timeout_seconds: 10,
  });
  expect(done.body).toMatchObject({ filled: true, secret_id: secretId });

  await a.client.close();
  await b.client.close();
}, 60_000);

test("a pending fill survives a broker restart", async () => {
  const before = await connect();
  const secretId = await demoSecretId(before);
  const uid = await openLogin(before);
  const parked = (
    await before.call("fill_secret", {
      secret_id: secretId,
      element_uid: uid,
    })
  ).body;
  expect(parked.status).toBe("pending_approval");

  // The fill is on disk, encrypted.
  const files = readdirSync(fillDir).filter((f) => f.endsWith(".fill"));
  expect(files.length).toBe(1);
  const onDisk = readFileSync(join(fillDir, files[0]!), "utf8");
  expect(onDisk).not.toContain(parked.fill_id);
  expect(onDisk).not.toContain("demo-login-password");

  await broker.stop();
  broker = await startBroker();

  // A new session (the old one died with the process) claims the fill by
  // id. The old element uids died with the old browser, so the broker says
  // how to re-target instead of burning the approval.
  const after = await connect();
  const stale = await after.call("await_fill", { fill_id: parked.fill_id });
  expect(stale.isError).toBe(true);
  expect(stale.text).toContain("call await_fill again");

  const freshUid = await openLogin(after);
  const done = await after.call("await_fill", {
    fill_id: parked.fill_id,
    element_uid: freshUid,
    timeout_seconds: 10,
  });
  expect(done.body).toMatchObject({ filled: true, secret_id: secretId });
  expect(readdirSync(fillDir).filter((f) => f.endsWith(".fill"))).toEqual([]);

  const snap = (await after.call("snapshot")).body;
  const filled = snap.elements.find((e: { uid: string }) => e.uid === freshUid);
  expect(filled?.value).toBe("[REDACTED:secret-filled-field]");
  await after.client.close();
}, 60_000);

test("await_fill refuses to re-target a card fill at an unkeyed element", async () => {
  const s = await connect();
  const refs = (await s.call("list_secret_refs")).body.refs;
  const cardId = refs.find((r: { name?: string }) => r.name === "demo-card")
    .secretId as string;

  await s.call("navigate", { url: `${FIXTURE_ORIGIN}/checkout` });
  const snap = (await s.call("snapshot")).body;
  const byName = (name: string) =>
    snap.elements.find((e: { name?: string }) => e.name === name).uid as string;
  const cardFields = ["cardNumber", "cardExpiry", "cardCvc"];

  const parked = (
    await s.call("fill_secret", {
      secret_id: cardId,
      fields: [
        { key: "number", element_uid: byName("cardNumber") },
        { key: "expiry", element_uid: byName("cardExpiry") },
        { key: "cvc", element_uid: byName("cardCvc") },
      ],
    })
  ).body;
  expect(parked.status).toBe("pending_approval");

  // The re-target path runs the same checks as fill_secret: an unkeyed
  // element_uid would put the whole JSON payload into one field.
  const unkeyed = await s.call("await_fill", {
    fill_id: parked.fill_id,
    element_uid: byName("cardName"),
    timeout_seconds: 5,
  });
  expect(unkeyed.isError).toBe(true);
  expect(unkeyed.text).toContain("unkeyed_target_for_field_binding");

  // A refused re-target leaves the parked targets in place.
  const done = await s.call("await_fill", {
    fill_id: parked.fill_id,
    timeout_seconds: 10,
  });
  expect(done.body).toMatchObject({ filled: true, secret_id: cardId });
  expect(done.body.element_uids).toEqual(cardFields.map(byName));

  const after = (await s.call("snapshot")).body;
  const value = (name: string) =>
    after.elements.find((e: { name?: string }) => e.name === name)?.value;
  for (const name of cardFields) {
    expect(value(name)).toBe("[REDACTED:secret-filled-field]");
  }
  expect(value("cardName")).not.toBe("[REDACTED:secret-filled-field]");
  await s.client.close();
}, 60_000);

test("the plaintext never appeared in any HTTP response", () => {
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript).not.toContain(DEMO_PLAINTEXT);
  expect(transcript).not.toContain(CARD_NUMBER);
});
