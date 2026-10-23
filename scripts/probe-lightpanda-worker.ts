/** Credential-free compatibility test. Run in a separate network:none container. */
import { LightpandaHost } from "../src/browser/lightpanda.js";
import { BrowserSession } from "../src/browser/session.js";
const session = new BrowserSession(
  new LightpandaHost(process.argv[2] ?? "/ipc/browser.sock"),
);
try {
  await session.ensureStarted();
  console.log("PASS: pinned Lightpanda satisfies the startup observation gate");
} catch {
  console.log(
    "BLOCKED: pinned Lightpanda does not satisfy attachment/observation gate; no secrets used",
  );
  process.exitCode = 2;
} finally {
  await session.close();
}
