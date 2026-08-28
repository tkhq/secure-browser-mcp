import { afterAll, beforeAll, expect, test } from "bun:test";

import { startFixtureServer, FIXTURE_ORIGIN } from "./fixtures/serve.js";
import { McpStdioClient } from "./mcp-client.js";

/**
 * Consensus flow, end to end against the mock backend: a consensus-gated
 * fill parks as pending_approval, is idempotent while pending, stays pending
 * when awaited past its timeout, and completes through await_fill once the
 * (simulated) approval arrives — all without the plaintext ever reaching
 * stdout.
 */

const DEMO_PLAINTEXT = "mock-demo-p@ssw0rd-1234"; // mock-secrets.ts seed
const APPROVAL_DELAY_MS = 4_000;

let fixture: { stop: () => void };
let client: McpStdioClient;

type PendingBody = {
  filled: boolean;
  status: string;
  fill_id: string;
  activity_id: string;
};

beforeAll(async () => {
  fixture = startFixtureServer();
  client = new McpStdioClient({
    SBM_MOCK_CONSENSUS: "demo-login-password",
    SBM_MOCK_CONSENSUS_DELAY_MS: String(APPROVAL_DELAY_MS),
  });
  await client.initialize();
});

afterAll(async () => {
  await client.stop();
  fixture.stop();
});

test("consensus-gated fill parks, stays pending, then completes", async () => {
  const refs = (await client.callTool("list_secret_refs")).body as {
    refs: { secretId: string; name?: string }[];
  };
  const demo = refs.refs.find((r) => r.name === "demo-login-password")!;

  await client.callTool("navigate", { url: `${FIXTURE_ORIGIN}/login` });
  const snap = (await client.callTool("snapshot")).body as {
    elements: { uid: string; type?: string }[];
  };
  const password = snap.elements.find((e) => e.type === "password")!;

  // The export needs approval: the fill parks instead of completing.
  const first = await client.callTool("fill_secret", {
    secret_id: demo.secretId,
    element_uid: password.uid,
  });
  expect(first.isError).toBe(false);
  const pending = first.body as PendingBody;
  expect(pending).toMatchObject({ filled: false, status: "pending_approval" });
  expect(pending.fill_id).toBeTruthy();

  // Re-requesting the same fill returns the same handle, not a duplicate.
  const again = await client.callTool("fill_secret", {
    secret_id: demo.secretId,
    element_uid: password.uid,
  });
  expect((again.body as PendingBody).fill_id).toBe(pending.fill_id);

  // Awaiting with a short timeout reports pending; the fill stays alive.
  const early = await client.callTool("await_fill", {
    fill_id: pending.fill_id,
    timeout_seconds: 1,
  });
  expect(early.isError).toBe(false);
  expect((early.body as PendingBody).status).toBe("pending_approval");

  // Awaiting past the simulated approval completes the fill for real.
  const done = await client.callTool("await_fill", {
    fill_id: pending.fill_id,
    timeout_seconds: 15,
  });
  expect(done.isError).toBe(false);
  expect(done.body).toMatchObject({ filled: true, secret_id: demo.secretId });

  // The fill id is consumed.
  const replay = await client.callTool("await_fill", {
    fill_id: pending.fill_id,
  });
  expect(replay.isError).toBe(true);

  // Field is filled and structurally redacted.
  const snap2 = (await client.callTool("snapshot")).body as {
    elements: { uid: string; value?: string }[];
  };
  const filled = snap2.elements.find((e) => e.uid === password.uid);
  expect(filled?.value).toBe("[REDACTED:secret-filled-field]");
}, 30_000);

test("the plaintext never appeared anywhere in server output", () => {
  expect(client.transcript.length).toBeGreaterThan(0);
  expect(client.transcript).not.toContain(DEMO_PLAINTEXT);
});
