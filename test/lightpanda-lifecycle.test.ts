import { expect, test } from "bun:test";
import { LightpandaHost } from "../src/browser/lightpanda.js";
import { BrowserSession } from "../src/browser/session.js";
const socket = process.env["SBM_TEST_LIFECYCLE_SOCKET"];
test.skipIf(!socket)(
  "running worker loss invalidates the session and refuses reconnect",
  async () => {
    const session = new BrowserSession(new LightpandaHost(socket!));
    try {
      await session.ensureStarted();
      expect(session.isStarted()).toBe(true);
      console.log("WORKER_ATTACHED"); // Fixed readiness marker for the external crash harness.
      const until = Date.now() + 10000;
      while (session.isStarted() && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect(session.isStarted()).toBe(false);
      await expect(session.ensureStarted()).rejects.toThrow("consumed");
    } finally {
      await session.close();
    }
  },
  15000,
);
