/** Test-only loopback fixture inside the network:none worker container. */
import { runWorker } from "../src/worker/lightpanda.js";
const fixture = Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  fetch: () =>
    new Response(
      '<html><body><input type="password" name="password"><input name="other"></body></html>',
      { headers: { "content-type": "text/html" } },
    ),
});
const worker = await runWorker(
  "/ipc/browser.sock",
  "/usr/local/bin/lightpanda",
  Number(process.argv[2] ?? "300000"),
);
process.once("SIGTERM", () => void worker.stop());
await worker.done;
fixture.stop(true);
