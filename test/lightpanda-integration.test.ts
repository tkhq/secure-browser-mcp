import { expect, test } from "bun:test";
import { RedactionRegistry } from "@turnkey/browser-secrets";
import { LightpandaHost } from "../src/browser/lightpanda.js";
import { BrowserSession } from "../src/browser/session.js";
import { captureSnapshot } from "../src/browser/snapshot.js";
import { observeTargets, topLevelDocument } from "../src/browser/observe.js";
import { MockSecretsClient } from "../src/broker/mock-secrets.js";
import {
  MemoryPendingFillStore,
  scopedFills,
} from "../src/broker/pending-store.js";
import { BrowserHandles, browserScope } from "../src/browsers.js";
import { fillSecret } from "../src/tools/fill-secret.js";
import { awaitFill } from "../src/tools/await-fill.js";
import type { ToolContext } from "../src/tools/tool.js";

const socket = process.env["SBM_TEST_WORKER_SOCKET"];
test.skipIf(!socket)(
  "isolated Lightpanda: live observations, approval, fill, redaction and denied destinations",
  async () => {
    const session = new BrowserSession(new LightpandaHost(socket!));
    const registry = new RedactionRegistry();
    const secrets = new MockSecretsClient(
      [
        {
          name: "fixture",
          value: "synthetic-worker-test-password",
          staticProperties: {
            "sbm:origin": "http://127.0.0.1:4173",
            "sbm:url-pattern": "/login*",
            "sbm:selector": 'input[type="password"]',
          },
        },
      ],
      { consensusNames: ["fixture"], approvalDelayMs: 100 },
    );
    const pendingFills = scopedFills(new MemoryPendingFillStore(), {
      owner: "test",
      principal: "test",
    });
    const browser = { session, registry, pendingFills };
    const ctx: ToolContext = {
      ...browser,
      secrets,
      backend: "mock",
      browsers: browserScope({
        handles: new BrowserHandles(
          { max: 1, perEndpoint: 1, perPrincipal: () => 1 },
          300000,
        ),
        owner: { endpoint: "test", principal: "test", client: "test" },
        make: () => browser,
        implicit: browser,
      }),
    };
    try {
      const page = await session.ensureStarted();
      await page.goto("http://127.0.0.1:4173/login");
      let snapshot = await captureSnapshot(session, registry);
      const uid = snapshot.elements.find((e) => e.name === "password")!.uid;
      const [ref] = await secrets.listRefs();
      const before = await topLevelDocument(session);
      await page.evaluate(() => {
        Element.prototype.matches = () => false;
      });
      const observation = await observeTargets(session, ref!, {
        targets: [{ elementId: uid }],
      });
      expect(
        observation.targets[0]?.selectorMatches['input[type="password"]'],
      ).toBe(true);
      const pending = (await fillSecret.handler(ctx, {
        secret_id: ref!.secretId,
        element_uid: uid,
      })) as { status: string; fill_id: string };
      expect(pending.status).toBe("pending_approval");
      const result = await awaitFill.handler(ctx, {
        fill_id: pending.fill_id,
        timeout_seconds: 1,
      });
      expect(result).toMatchObject({ filled: true });
      snapshot = await captureSnapshot(session, registry);
      expect(JSON.stringify(snapshot)).not.toContain(
        "synthetic-worker-test-password",
      );
      expect(
        await page.$eval(
          'input[type="password"]',
          (el) => (el as HTMLInputElement).value.length,
        ),
      ).toBe(30);
      const other = snapshot.elements.find((e) => e.name === "other")!.uid;
      await expect(
        fillSecret.handler(ctx, {
          secret_id: ref!.secretId,
          element_uid: other,
        }),
      ).rejects.toThrow();
      // Cancellation after an approved export must release it without a write.
      const pendingAgain = (await fillSecret.handler(ctx, {
        secret_id: ref!.secretId,
        element_uid: uid,
      })) as { fill_id: string };
      const abort = new AbortController();
      const originalAwait = secrets.awaitExport.bind(secrets);
      let released = false;
      secrets.awaitExport = async (...args) => {
        const exported = await originalAwait(...args);
        abort.abort();
        return {
          ...exported,
          release: () => {
            released = true;
            exported.release();
          },
        };
      };
      await page.$eval('input[type="password"]', (el) => {
        (el as HTMLInputElement).value = "";
      });
      await expect(
        awaitFill.handler(
          { ...ctx, signal: abort.signal },
          { fill_id: pendingAgain.fill_id, timeout_seconds: 1 },
        ),
      ).rejects.toThrow("Request cancelled");
      expect(released).toBe(true);
      expect(
        await page.$eval(
          'input[type="password"]',
          (el) => (el as HTMLInputElement).value.length,
        ),
      ).toBe(0);
      secrets.awaitExport = originalAwait;
      const second = new LightpandaHost(socket!);
      await expect(second.start()).rejects.toThrow();
      expect(session.isStarted()).toBe(true);
      await page.goto("http://127.0.0.1:4173/wrong");
      expect((await topLevelDocument(session)).document.documentId).not.toBe(
        before.document.documentId,
      );
      snapshot = await captureSnapshot(session, registry);
      await expect(
        fillSecret.handler(ctx, {
          secret_id: ref!.secretId,
          element_uid: snapshot.elements[0]!.uid,
        }),
      ).rejects.toThrow();
      await session.close();
      await expect(session.ensureStarted()).rejects.toThrow("consumed");
    } finally {
      await session.close();
    }
  },
  30000,
);
