import { afterAll, beforeAll, expect, test } from "bun:test";

import { LightpandaHost } from "../src/browser/hosts.js";

/**
 * LightpandaHost. The start-failure test always runs. The others need a
 * Lightpanda binary in SBM_LIGHTPANDA_PATH and are skipped without one.
 * To run the full e2e suite on Lightpanda:
 *   SBM_BROWSER=lightpanda SBM_LIGHTPANDA_PATH=... bun test test/e2e.test.ts
 */

const binary = process.env["SBM_LIGHTPANDA_PATH"];
const withBinary = binary ? test : test.skip;

const PAGE = `<!doctype html><title>Card</title>
<input id=pw type=password>
<iframe src="/frame"></iframe>`;
const FRAME = `<!doctype html><input name=cc autocomplete=cc-number>`;

let site: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  site = Bun.serve({
    port: 0,
    fetch: (req) =>
      new Response(new URL(req.url).pathname === "/frame" ? FRAME : PAGE, {
        headers: { "content-type": "text/html" },
      }),
  });
});

afterAll(() => site.stop(true));

test("reports a binary that does not start", async () => {
  const host = new LightpandaHost({
    executablePath: "/nonexistent/lightpanda",
    startTimeoutMs: 2_000,
  });
  await expect(host.start()).rejects.toThrow("Lightpanda did not start");
  await host.stop();
});

withBinary(
  "drives a page through the broker's CDP calls, iframes included",
  async () => {
    const host = new LightpandaHost({ executablePath: binary! });
    try {
      const browser = await host.start();
      const page = await host.openPage(browser);
      await page.goto(`http://127.0.0.1:${site.port}/`, { waitUntil: "load" });
      expect(await page.title()).toBe("Card");

      // The fill path in src/browser/inject.ts.
      const cdp = await page.createCDPSession();
      const field = (await page.$("#pw"))!;
      await cdp.send("DOM.getDocument", { depth: 0 });
      await cdp.send("DOM.focus", {
        backendNodeId: await field.backendNodeId(),
      });
      await cdp.send("Input.insertText", { text: "canary-1234" });
      expect(
        await field.evaluate((el) => (el as HTMLInputElement).value.length),
      ).toBe(11);

      // --load-resources iframe: the frame and its field are reachable.
      const frame = page.frames().find((f) => f.url().endsWith("/frame"));
      expect(frame).toBeDefined();
      expect(await frame!.$$("input")).toHaveLength(1);
    } finally {
      await host.stop();
    }
  },
  30_000,
);

withBinary(
  "stop ends the browser, and a new start gets a fresh one",
  async () => {
    const host = new LightpandaHost({ executablePath: binary! });
    const first = await host.start();
    await host.stop();
    expect(first.connected).toBe(false);
    await host.stop(); // a second stop is a no-op

    const second = await host.start();
    try {
      expect(second.connected).toBe(true);
      const page = await host.openPage(second);
      expect(page.url()).toBe("about:blank");
    } finally {
      await host.stop();
    }
  },
  30_000,
);
