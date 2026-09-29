import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { FIXTURE_ORIGIN, startFixtureServer } from "./fixtures/serve.js";
import { McpStdioClient } from "./mcp-client.js";

/**
 * The hosted broker (src/http.ts), black box: EMG-89 step 1 acceptance.
 * Same tools as stdio, sessions isolated from each other, and a pending
 * fill that survives a broker restart.
 */

const TOKEN = "test-token";
const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed
const stateDir = mkdtempSync(join(tmpdir(), "sbm-state-"));
const stateKey = randomBytes(32).toString("hex");
const port = 18_000 + Math.floor(Math.random() * 2_000);
const url = `http://127.0.0.1:${port}/mcp`;

/** Every response body the server sent, for leak assertions. */
let transcript = "";
let fixture: { stop: () => void };
let broker: BrokerProcess;

type BrokerProcess = { stop: () => Promise<void> };

async function startBroker(): Promise<BrokerProcess> {
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

type Session = {
  client: Client;
  call: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ isError: boolean; body: any; text: string }>;
};

async function connect(): Promise<Session> {
  const client = new Client({ name: "http-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
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

async function openLogin(s: Session) {
  await s.call("navigate", { url: `${FIXTURE_ORIGIN}/login` });
  const snap = (await s.call("snapshot")).body;
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
  const files = readdirSync(stateDir).filter((f) => f.endsWith(".fill"));
  expect(files.length).toBe(1);
  const onDisk = readFileSync(join(stateDir, files[0]!), "utf8");
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
  expect(readdirSync(stateDir).filter((f) => f.endsWith(".fill"))).toEqual([]);

  const snap = (await after.call("snapshot")).body;
  const filled = snap.elements.find((e: { uid: string }) => e.uid === freshUid);
  expect(filled?.value).toBe("[REDACTED:secret-filled-field]");
  await after.client.close();
}, 60_000);

test("the plaintext never appeared in any HTTP response", () => {
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript).not.toContain(DEMO_PLAINTEXT);
});
