// Manual probe: spawn the server, navigate, snapshot, print raw results.
// Debug utility only; the real coverage is e2e.test.ts.
import { startFixtureServer, FIXTURE_ORIGIN } from "./fixtures/serve.js";

const fixture = startFixtureServer();
const proc = Bun.spawn(["bun", "src/index.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});

let buffer = "";
const replies = new Map<number, (line: string) => void>();
void (async () => {
  for await (const chunk of proc.stdout) {
    buffer += new TextDecoder().decode(chunk);
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) replies.get(msg.id)?.(line);
    }
  }
})();

function request(
  id: number,
  method: string,
  params?: unknown,
): Promise<string> {
  const p = new Promise<string>((resolve) => replies.set(id, resolve));
  proc.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
  );
  return p;
}

await request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "probe", version: "0" },
});
proc.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
    "\n",
);

console.log(
  "nav:",
  (
    await request(2, "tools/call", {
      name: "navigate",
      arguments: { url: `${FIXTURE_ORIGIN}/login` },
    })
  ).slice(0, 300),
);
const snap = JSON.parse(
  JSON.parse(
    await request(3, "tools/call", { name: "snapshot", arguments: {} }),
  ).result.content[0].text,
);
const password = snap.elements.find(
  (e: { type?: string }) => e.type === "password",
);
console.log(
  "fill:",
  await request(4, "tools/call", {
    name: "fill_secret",
    arguments: { secret_id: "mock-secret-1", element_uid: password.uid },
  }),
);
console.log(
  "snap2:",
  (await request(5, "tools/call", { name: "snapshot", arguments: {} })).slice(
    0,
    1200,
  ),
);

proc.kill();
fixture.stop();
process.exit(0);
