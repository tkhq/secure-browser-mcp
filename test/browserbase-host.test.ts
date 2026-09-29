import { afterAll, beforeAll, expect, test } from "bun:test";

import { BrowserbaseHost } from "../src/browser/hosts.js";

/**
 * BrowserbaseHost against a fake Browserbase API: sessions are created with
 * recording and logs off, and a session is released even when the CDP
 * connection fails.
 */

type Call = { method: string; path: string; key: string | null; body: any };
const calls: Call[] = [];
let api: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  api = Bun.serve({
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      const body = req.method === "POST" ? await req.json() : undefined;
      calls.push({
        method: req.method,
        path: pathname,
        key: req.headers.get("x-bb-api-key"),
        body,
      });
      if (pathname === "/v1/projects") {
        return Response.json([{ id: "proj-1" }]);
      }
      if (pathname === "/v1/sessions" && req.method === "POST") {
        // Nothing listens here, so the CDP connect fails.
        return Response.json({ id: "sess-1", connectUrl: "ws://127.0.0.1:1" });
      }
      return Response.json({});
    },
  });
});

afterAll(() => api.stop(true));

test("creates a session with recording and logs off, and releases it when connect fails", async () => {
  const host = new BrowserbaseHost({
    apiKey: "bb-test-key",
    apiBaseUrl: `http://127.0.0.1:${api.port}/v1`,
  });
  await expect(host.start()).rejects.toThrow();

  const create = calls.find((c) => c.path === "/v1/sessions")!;
  expect(create.key).toBe("bb-test-key");
  expect(create.body).toMatchObject({
    projectId: "proj-1",
    keepAlive: false,
    browserSettings: { recordSession: false, logSession: false },
  });

  const release = calls.find((c) => c.path === "/v1/sessions/sess-1")!;
  expect(release.body).toEqual({
    projectId: "proj-1",
    status: "REQUEST_RELEASE",
  });

  // stop() after a release does not release again.
  const before = calls.length;
  await host.stop();
  expect(calls.length).toBe(before);
});
