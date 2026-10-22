import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { MemoryPendingFillStore, scopedFills } from "./broker/pending-store.js";
import { BrowserHandles, browserScope } from "./browsers.js";
import { brokerContext, browserContext, makeBroker } from "./runtime.js";
import { createServer } from "./server.js";

const OWNER = { endpoint: "stdio", principal: "stdio", client: undefined };

async function main(): Promise<void> {
  const broker = makeBroker();
  // One process, one agent session: pending fills live in memory and die
  // with the process. The hosted entrypoint (src/http.ts) persists them.
  const store = new MemoryPendingFillStore();
  const idleS = Number(process.env["SBM_SESSION_IDLE_S"] ?? "1800");
  // The process's own browser, plus any the agent opens with open_browser.
  const handles = new BrowserHandles(
    { max: 4, perEndpoint: 4, perPrincipal: () => 4 },
    (idleS > 0 ? idleS : 1800) * 1_000,
  );
  const isLive = (owner: string) => owner === "stdio" || handles.has(owner);
  const implicit = browserContext(
    broker,
    scopedFills(store, { owner: "stdio", principal: "stdio", isLive }),
  );
  const scope = browserScope({
    handles,
    owner: OWNER,
    make: (id) =>
      browserContext(
        broker,
        scopedFills(store, { owner: id, principal: "stdio", isLive }),
      ),
    implicit,
  });

  const server = createServer(brokerContext(broker, scope));
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP transport; diagnostics go to stderr only.
  console.error(
    `secure-browser-mcp: listening on stdio (backend: ${broker.backend}, ` +
      `browser: ${broker.browser})`,
  );
  const sweep = setInterval(() => void handles.sweep(), 60_000);
  sweep.unref();

  // When the client disconnects, take the browsers down with us — an
  // orphaned broker browser is an unowned browser.
  const shutdown = () => {
    void Promise.all([implicit.session.close(), handles.closeAll()]).finally(
      () => process.exit(0),
    );
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("secure-browser-mcp: fatal:", err);
  process.exit(1);
});
