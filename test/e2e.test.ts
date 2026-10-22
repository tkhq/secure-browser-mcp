import { afterAll, beforeAll, expect, test } from "bun:test";

import { startFixtureServer, FIXTURE_ORIGIN } from "./fixtures/serve.js";
import { McpStdioClient } from "./mcp-client.js";

/**
 * End-to-end: drive the real MCP server over stdio as a black box, exactly
 * like an agent would, and assert the core security property — the secret
 * plaintext never appears in anything the server writes to stdout.
 */

const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed
/** The fixture server on another site, for a cross-site navigation. */
const OTHER_SITE = FIXTURE_ORIGIN.replace("localhost", "127.0.0.1");

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
    "open_browser",
    "close_browser",
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
  expect(fill.body).toEqual({
    filled: true,
    confirmed: true,
    secret_id: demo!.secretId,
    element_uids: [password!.uid],
    fields: [
      {
        element_uid: password!.uid,
        length: DEMO_PLAINTEXT.length,
        matches: true,
        valid: true,
      },
    ],
  });

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
  expect(fill.text).toContain("top_level_origin_mismatch");
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

  // An unkeyed fill would write the whole JSON payload into one field; the
  // binding declares per-key selectors, so it is refused before any export.
  const unkeyed = await client.callTool("fill_secret", {
    secret_id: card!.secretId,
    element_uid: byName("cardName"),
  });
  expect(unkeyed.isError).toBe(true);
  expect(unkeyed.text).toContain("unkeyed_target_for_field_binding");

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

test("a new document does not inherit the old document's redaction tags", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const card = refs.refs.find((r) => r.name === "demo-card");
  type Snap = { elements: { uid: string; name?: string; value?: string }[] };
  const cardFields = ["cardNumber", "cardExpiry", "cardCvc"];
  const checkout = async (origin: string) => {
    await client.callTool("navigate", { url: `${origin}/checkout` });
    return (await client.callTool("snapshot")).body as Snap;
  };
  const uids = (snap: Snap) =>
    cardFields.map((name) => snap.elements.find((e) => e.name === name)!.uid);
  const fillCard = (snap: Snap) => {
    const [number, expiry, cvc] = uids(snap);
    return client.callTool("fill_secret", {
      secret_id: card!.secretId,
      fields: [
        { key: "number", element_uid: number },
        { key: "expiry", element_uid: expiry },
        { key: "cvc", element_uid: cvc },
      ],
    });
  };
  const values = (snap: Snap) =>
    cardFields.map((name) => snap.elements.find((e) => e.name === name)?.value);
  const redacted = cardFields.map(() => "[REDACTED:secret-filled-field]");

  // A cross-site load gets a new renderer process, and a new process
  // numbers its nodes from the start again. So the fixture form gets the
  // same uids each time it loads after a cross-site hop.
  await checkout(OTHER_SITE);
  const first = await checkout(FIXTURE_ORIGIN);
  expect((await fillCard(first)).isError).toBe(false);
  expect(values((await client.callTool("snapshot")).body as Snap)).toEqual(
    redacted,
  );

  await checkout(OTHER_SITE);
  const second = await checkout(FIXTURE_ORIGIN);
  expect(uids(second)).toEqual(uids(first));
  expect(values(second)).toEqual(["", "", ""]);

  // A new fill tags the fields again.
  expect((await fillCard(second)).isError).toBe(false);
  expect(values((await client.callTool("snapshot")).body as Snap)).toEqual(
    redacted,
  );
});

test("redacts a card number the page reformats, re-renders and echoes", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const card = refs.refs.find((r) => r.name === "demo-card");

  await client.callTool("navigate", {
    url: `${FIXTURE_ORIGIN}/checkout-formatted`,
  });
  const snap = (await client.callTool("snapshot")).body as {
    elements: { uid: string; name?: string }[];
  };
  const byName = (name: string) =>
    snap.elements.find((e) => e.name === name)!.uid;
  const fill = await client.callTool("fill_secret", {
    secret_id: card!.secretId,
    fields: [
      { key: "number", element_uid: byName("cardNumber") },
      { key: "expiry", element_uid: byName("cardExpiry") },
      { key: "cvc", element_uid: byName("cardCvc") },
    ],
  });
  expect(fill.isError).toBe(false);
  // The page grouped the number in fours; it still holds the secret.
  expect(fill.body).toMatchObject({
    confirmed: true,
    fields: [{ key: "number", length: 19, matches: true }, {}, {}],
  });

  const snap2 = (await client.callTool("snapshot")).body as {
    elements: { uid: string; name?: string; text?: string; value?: string }[];
  };
  // The page replaced the number input, so it has a fresh, untagged uid.
  const number = snap2.elements.find((e) => e.name === "cardNumber")!;
  expect(number.uid).not.toBe(byName("cardNumber"));
  expect(number.value).toBe("[REDACTED:secret-filled-field]");
  const summary = snap2.elements.find((e) => e.name === "summary")!;
  expect(summary.value).toBe("[REDACTED:secret-filled-field]");
  const pay = snap2.elements.find((e) => e.text?.startsWith("Pay"))!;
  expect(pay.text).toBe(`Pay $9.99 with [REDACTED:${card!.secretId}]`);

  expect(client.transcript).not.toContain("4242 4242 4242 4242");
  expect(client.transcript).not.toMatch(/4242\D?4242\D?4242\D?4242/);
});

test("redacts a card number the page splits across fields and the URL", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const card = refs.refs.find((r) => r.name === "demo-card");

  await client.callTool("navigate", {
    url: `${FIXTURE_ORIGIN}/checkout-split`,
  });
  const snap = (await client.callTool("snapshot")).body as {
    elements: { uid: string; name?: string }[];
  };
  const byName = (name: string) =>
    snap.elements.find((e) => e.name === name)!.uid;
  const fill = await client.callTool("fill_secret", {
    secret_id: card!.secretId,
    fields: [
      { key: "number", element_uid: byName("cardNumber") },
      { key: "expiry", element_uid: byName("cardExpiry") },
      { key: "cvc", element_uid: byName("cardCvc") },
    ],
  });
  expect(fill.isError).toBe(false);

  const snap2 = (await client.callTool("snapshot")).body as {
    url: string;
    elements: { name?: string; value?: string }[];
  };
  const parts = snap2.elements.filter((e) => e.name?.startsWith("cardPart"));
  expect(parts).toHaveLength(4);
  for (const part of parts) {
    expect(part.value).toBe("[REDACTED:secret-filled-field]");
  }
  expect(snap2.url).toBe(
    `${FIXTURE_ORIGIN}/checkout-split?card=[REDACTED:${card!.secretId}]`,
  );
  expect(client.transcript).not.toMatch(/4242(%20|\D)?4242(%20|\D)?4242/);
});

test("a browser_id names a browser of its own, beside the session's", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const demo = refs.refs.find((r) => r.name === "demo-login-password")!;
  await client.callTool("navigate", { url: `${FIXTURE_ORIGIN}/checkout` });

  const opened = await client.callTool("open_browser");
  expect(opened.isError).toBe(false);
  const { browser_id } = opened.body as { browser_id: string };
  expect(browser_id).toMatch(/^br_[A-Za-z0-9_-]{32}$/);

  await client.callTool("navigate", {
    url: `${FIXTURE_ORIGIN}/login`,
    browser_id,
  });
  const snap = (await client.callTool("snapshot", { browser_id })).body as {
    url: string;
    elements: { uid: string; type?: string; value?: string }[];
  };
  expect(snap.url).toContain("/login");
  const password = snap.elements.find((e) => e.type === "password")!;
  const fill = await client.callTool("fill_secret", {
    secret_id: demo.secretId,
    element_uid: password.uid,
    browser_id,
  });
  expect(fill.body).toMatchObject({ filled: true });

  // The session's own browser did not move.
  const own = (await client.callTool("snapshot")).body as { url: string };
  expect(own.url).toContain("/checkout");

  const after = (await client.callTool("snapshot", { browser_id })).body as {
    elements: { uid: string; value?: string }[];
  };
  expect(after.elements.find((e) => e.uid === password.uid)?.value).toBe(
    "[REDACTED:secret-filled-field]",
  );

  expect((await client.callTool("close_browser", { browser_id })).body).toEqual(
    { closed: browser_id },
  );
  const gone = await client.callTool("snapshot", { browser_id });
  expect(gone.isError).toBe(true);
  expect(gone.text).toContain("Unknown browser_id");
});

test("reports a field the page cleared or rejects after a fill", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const card = refs.refs.find((r) => r.name === "demo-card");

  await client.callTool("navigate", {
    url: `${FIXTURE_ORIGIN}/checkout-clearing`,
  });
  const snap = (await client.callTool("snapshot")).body as {
    elements: { uid: string; name?: string }[];
  };
  const byName = (name: string) =>
    snap.elements.find((e) => e.name === name)!.uid;
  const fill = await client.callTool("fill_secret", {
    secret_id: card!.secretId,
    fields: [
      { key: "number", element_uid: byName("cardNumber") },
      { key: "expiry", element_uid: byName("cardExpiry") },
      { key: "cvc", element_uid: byName("cardCvc") },
    ],
  });
  expect(fill.isError).toBe(false);
  expect(fill.body).toEqual({
    filled: true,
    confirmed: false,
    secret_id: card!.secretId,
    element_uids: [
      byName("cardNumber"),
      byName("cardExpiry"),
      byName("cardCvc"),
    ],
    fields: [
      {
        element_uid: byName("cardNumber"),
        key: "number",
        length: 0,
        matches: false,
        valid: true,
      },
      {
        element_uid: byName("cardExpiry"),
        key: "expiry",
        length: 4,
        matches: true,
        valid: false,
      },
      {
        element_uid: byName("cardCvc"),
        key: "cvc",
        length: 3,
        matches: true,
        valid: true,
      },
    ],
  });
  // The facts hold no part of any value.
  expect(fill.text).not.toMatch(/4242|"1234"|"123"/);
});

test("the plaintext never appeared anywhere in server output", () => {
  expect(client.transcript.length).toBeGreaterThan(0);
  expect(client.transcript).not.toContain(DEMO_PLAINTEXT);
});
