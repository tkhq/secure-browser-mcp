import { expect, test } from "bun:test";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect } from "node:net";
import { browserEnvironment, runWorker } from "../src/worker/lightpanda.js";
import {
  WorkerTransport,
  readFrames,
  writeFrame,
  MAX_CDP_BYTES,
} from "../src/browser/lightpanda-transport.js";
import { LocalChromeHost } from "../src/browser/hosts.js";
import { findChrome } from "../src/runtime.js";
import {
  LightpandaHost,
  verifyObservationIsolation,
} from "../src/browser/lightpanda.js";

async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "sbm-lp-"));
  await chmod(dir, 0o700);
  return dir;
}

test("browser environment excludes credentials, proxy settings and loader hooks", () => {
  const saved = process.env["TURNKEY_API_PRIVATE_KEY"];
  process.env["TURNKEY_API_PRIVATE_KEY"] = "synthetic-do-not-forward";
  try {
    expect(browserEnvironment()).toEqual({
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      LIGHTPANDA_DISABLE_TELEMETRY: "true",
    });
  } finally {
    if (saved === undefined) delete process.env["TURNKEY_API_PRIVATE_KEY"];
    else process.env["TURNKEY_API_PRIVATE_KEY"] = saved;
  }
});

test("private transport roundtrips bounded CDP without a TCP endpoint", async () => {
  const dir = await directory();
  const path = join(dir, "cdp.sock");
  const server = createServer((socket) =>
    readFrames(socket, (message) => writeFrame(socket, message)),
  );
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  try {
    const transport = await WorkerTransport.open(path);
    const received = new Promise<string>((resolve) => {
      transport.onmessage = resolve;
    });
    transport.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    expect(JSON.parse(await received).id).toBe(1);
    expect(() => transport.send("x".repeat(MAX_CDP_BYTES + 1))).toThrow(
      "unavailable",
    );
    transport.close();
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("wrong destination and world-readable socket directories fail closed", async () => {
  const dir = await directory();
  try {
    await expect(WorkerTransport.open("ws://127.0.0.1:9222")).rejects.toThrow();
    await chmod(dir, 0o755);
    await expect(WorkerTransport.open(join(dir, "cdp.sock"))).rejects.toThrow(
      "0700",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("idle worker expires without launching browser and cannot be attached", async () => {
  const dir = await directory();
  const path = join(dir, "cdp.sock");
  try {
    const worker = await runWorker(path, "/not/an/executable", 1000);
    await worker.done;
    await expect(WorkerTransport.open(path)).rejects.toThrow();
    await worker.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker startup crash consumes lease; no cross-session attach or reconnect", async () => {
  const dir = await directory();
  const path = join(dir, "cdp.sock");
  try {
    const worker = await runWorker(path, "/not/an/executable", 1000);
    const socket = connect(path);
    socket.on("error", () => {});
    await worker.done;
    await expect(WorkerTransport.open(path)).rejects.toThrow();
    socket.destroy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed host attachment is never retried against another session", async () => {
  const dir = await directory();
  try {
    const host = new LightpandaHost(join(dir, "absent.sock"));
    await expect(host.start()).rejects.toThrow("attachment failed");
    await expect(host.start()).rejects.toThrow("consumed");
    await host.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelling attachment closes transport and never returns a live browser", async () => {
  const dir = await directory();
  const path = join(dir, "cdp.sock");
  let connected!: () => void;
  const accepted = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const server = createServer((socket) => {
    socket.on("data", () => connected());
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  const host = new LightpandaHost(path);
  try {
    const start = host.start();
    const rejected = start.then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    await accepted;
    await host.stop();
    expect(await rejected).toContain("attachment failed");
    await expect(host.start()).rejects.toThrow("consumed");
  } finally {
    await host.stop();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 5000);

test("malformed peer frames close the channel without passing content", async () => {
  const dir = await directory();
  const path = join(dir, "cdp.sock");
  const server = createServer((socket) => socket.write("not JSON\n"));
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await chmod(path, 0o600);
  try {
    const transport = await WorkerTransport.open(path);
    let messages = 0;
    transport.onmessage = () => {
      ++messages;
    };
    await new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    expect(messages).toBe(0);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("observation gate passes on Chrome with real isolated worlds and fresh document IDs", async () => {
  const host = new LocalChromeHost({ executablePath: findChrome() });
  try {
    const browser = await host.start();
    const page = await browser.newPage();
    await verifyObservationIsolation(page);
    expect(page.url()).toBe("about:blank");
  } finally {
    await host.stop();
  }
});

test("cancellation after focus prevents the plaintext CDP write and releases it", async () => {
  const abort = new AbortController();
  const commands: string[] = [];
  let released = false;
  const session = {
    resolveElement: () => ({
      backendNodeId: 1,
      handle: { evaluate: async () => 0 },
    }),
    cdpSession: () => ({
      send: async (method: string) => {
        commands.push(method);
        if (method === "DOM.focus") abort.abort();
      },
    }),
  } as unknown as import("../src/browser/session.js").BrowserSession;
  const { injectSecret } = await import("../src/browser/inject.js");
  await expect(
    injectSecret(
      session,
      "field",
      {
        ref: { secretId: "fixture", staticProperties: {} },
        value: "synthetic",
        release: () => {
          released = true;
        },
      },
      abort.signal,
    ),
  ).rejects.toThrow("Request cancelled");
  expect(commands).not.toContain("Input.insertText");
  expect(released).toBe(true);
});
