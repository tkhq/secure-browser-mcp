import { afterAll, beforeAll, expect, test } from "bun:test";

import { startFixtureServer, FIXTURE_ORIGIN } from "./fixtures/serve.js";
import { McpStdioClient } from "./mcp-client.js";

/**
 * End-to-end: drive the real MCP server over stdio as a black box, exactly
 * like an agent would, and assert the core security property — the secret
 * plaintext never appears in anything the server writes to stdout.
 */

const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed

let fixture: { stop: () => void };
let client: McpStdioClient;

beforeAll(async () => {
  fixture = startFixtureServer();
  client = new McpStdioClient();
  await client.initialize();
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
    "await_fill",
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

test("fills a JSON card secret into several fields with one call", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const card = refs.refs.find((r) => r.name === "demo-card");
  expect(card).toBeDefined();

  await client.callTool("navigate", { url: `${FIXTURE_ORIGIN}/checkout` });
  const snap = (await client.callTool("snapshot")).body as {
    elements: { uid: string; name?: string }[];
  };
  const byName = (name: string) =>
    snap.elements.find((e) => e.name === name)!.uid;

  // A payload key the binding doesn't declare is refused before any export,
  // and a declared key aimed at the wrong element fails its selector check.
  const badKey = await client.callTool("fill_secret", {
    secret_id: card!.secretId,
    fields: [{ key: "name", element_uid: byName("cardName") }],
  });
  expect(badKey.isError).toBe(true);
  const wrongElement = await client.callTool("fill_secret", {
    secret_id: card!.secretId,
    fields: [{ key: "number", element_uid: byName("cardName") }],
  });
  expect(wrongElement.isError).toBe(true);

  const fill = await client.callTool("fill_secret", {
    secret_id: card!.secretId,
    fields: [
      { key: "number", element_uid: byName("cardNumber") },
      { key: "expiry", element_uid: byName("cardExpiry") },
      { key: "cvc", element_uid: byName("cardCvc") },
    ],
  });
  expect(fill.isError).toBe(false);
  expect(fill.body).toMatchObject({ filled: true });

  const snap2 = (await client.callTool("snapshot")).body as {
    elements: { name?: string; value?: string }[];
  };
  for (const name of ["cardNumber", "cardExpiry", "cardCvc"]) {
    const field = snap2.elements.find((e) => e.name === name);
    expect(field?.value).toBe("[REDACTED:secret-filled-field]");
  }
  expect(client.transcript).not.toContain("4242424242424242");
});

test("the plaintext never appeared anywhere in server output", () => {
  expect(client.transcript.length).toBeGreaterThan(0);
  expect(client.transcript).not.toContain(DEMO_PLAINTEXT);
});
