import { afterAll, beforeAll, expect, test } from "bun:test";

import { startFixtureServer, FIXTURE_ORIGIN } from "./fixtures/serve.js";

/**
 * End-to-end: drive the real MCP server over stdio as a black box, exactly
 * like an agent would, and assert the core security property — the secret
 * plaintext never appears in anything the server writes to stdout.
 */

const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed

type JsonRpcMessage = {
  id?: number;
  result?: {
    tools?: { name: string }[];
    isError?: boolean;
    content?: { type: string; text: string }[];
  };
  error?: { message: string };
};

class McpStdioClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();
  /** Every byte the server ever wrote to stdout, for leak assertions. */
  transcript = "";

  constructor() {
    this.proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SBM_HEADLESS: "true" },
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    for await (const chunk of this.proc.stdout) {
      const text = new TextDecoder().decode(chunk);
      this.transcript += text;
      this.buffer += text;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id !== undefined) {
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        }
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const done = new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
    });
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return done;
  }

  notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; body: unknown; text: string }> {
    const msg = await this.request("tools/call", { name, arguments: args });
    const text = msg.result?.content?.[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { isError: msg.result?.isError === true, body, text };
  }

  async stop(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}

let fixture: { stop: () => void };
let client: McpStdioClient;

beforeAll(async () => {
  fixture = startFixtureServer();
  client = new McpStdioClient();
  await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "e2e", version: "0" },
  });
  client.notify("notifications/initialized");
});

afterAll(async () => {
  await client.stop();
  fixture.stop();
});

test("lists the full tool surface, without evaluate_script", async () => {
  const msg = await client.request("tools/list");
  const names = (msg.result?.tools ?? []).map((t) => t.name);
  expect(names).toEqual([
    "list_secret_refs",
    "navigate",
    "snapshot",
    "click",
    "type_text",
    "fill_secret",
    "list_network_requests",
  ]);
});

test("fills a secret without ever exposing it", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const demo = refs.refs.find((r) => r.name === "demo-login-password");
  expect(demo).toBeDefined();

  const nav = await client.callTool("navigate", {
    url: `${FIXTURE_ORIGIN}/login`,
  });
  expect(nav.isError).toBe(false);

  const snap1 = (await client.callTool("snapshot")).body as {
    elements: { uid: string; type?: string; name?: string; value?: string }[];
  };
  const password = snap1.elements.find((e) => e.type === "password");
  const username = snap1.elements.find((e) => e.name === "username");
  expect(password).toBeDefined();
  expect(username).toBeDefined();

  const typed = await client.callTool("type_text", {
    element_uid: username!.uid,
    text: "carey",
  });
  expect(typed.isError).toBe(false);

  const fill = await client.callTool("fill_secret", {
    secret_id: demo!.secretId,
    element_uid: password!.uid,
  });
  expect(fill.isError).toBe(false);
  expect(fill.body).toMatchObject({ filled: true, secret_id: demo!.secretId });

  // The post-fill snapshot shows the field structurally redacted.
  const snap2 = (await client.callTool("snapshot")).body as {
    elements: { uid: string; value?: string }[];
  };
  const filled = snap2.elements.find((e) => e.uid === password!.uid);
  expect(filled?.value).toBe("[REDACTED:secret-filled-field]");
  // Non-secret typing still round-trips normally.
  const user2 = snap2.elements.find((e) => e.uid === username!.uid);
  expect(user2?.value).toBe("carey");
});

test("refuses to fill into a non-matching destination", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  // Bound to https://example.com, so the fixture page must be rejected.
  const wrongSite = refs.refs.find((r) => r.name === "example-login-password");
  const snap = (await client.callTool("snapshot")).body as {
    elements: { uid: string; type?: string }[];
  };
  const password = snap.elements.find((e) => e.type === "password");
  const fill = await client.callTool("fill_secret", {
    secret_id: wrongSite!.secretId,
    element_uid: password!.uid,
  });
  expect(fill.isError).toBe(true);
  expect(fill.text).toContain("does not match bound origin");
});

test("the plaintext never appeared anywhere in server output", () => {
  expect(client.transcript.length).toBeGreaterThan(0);
  expect(client.transcript).not.toContain(DEMO_PLAINTEXT);
});
