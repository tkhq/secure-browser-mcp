import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { MemoryPendingFillStore, scopedFills } from "./broker/pending-store.js";
import { makeBroker, sessionContext } from "./runtime.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const broker = makeBroker();
  // One process, one agent session: pending fills live in memory and die
  // with the process. The hosted entrypoint (src/http.ts) persists them.
  const ctx = sessionContext(
    broker,
    scopedFills(new MemoryPendingFillStore(), "stdio"),
  );

  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP transport; diagnostics go to stderr only.
  console.error(
    `secure-browser-mcp: listening on stdio (backend: ${broker.backend}, ` +
      `browser: ${broker.browser})`,
  );

  // When the client disconnects, take the browser down with us — an orphaned
  // broker browser is an unowned browser.
  const shutdown = () => {
    void ctx.session.close().finally(() => process.exit(0));
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
