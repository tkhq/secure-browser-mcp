/** Run only in a dedicated credential-free, network-isolated worker container. */
import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import {
  readFrames,
  writeFrame,
  validateSocketDirectory,
  MAX_CDP_BYTES,
} from "../browser/lightpanda-transport.js";

export function browserEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/tmp",
    TMPDIR: "/tmp",
    LIGHTPANDA_DISABLE_TELEMETRY: "true",
  };
}

export async function runWorker(
  socketPath: string,
  executablePath: string,
  lifetimeMs = 300000,
) {
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1000 ||
    lifetimeMs > 300000
  )
    throw new Error("Invalid worker lifetime");
  await validateSocketDirectory(socketPath);
  let used = false;
  let client: Socket | undefined;
  let ws: WebSocket | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = createServer((socket) => {
    socket.on("error", () => {});
    if (used || stopped) {
      socket.destroy();
      return;
    }
    used = true;
    client = socket;
    server.close(); // One connection, including failed startup. No reconnect.
    socket.once("close", () => void stop());
    void attach().catch(() => stop());
  });
  const timer = setTimeout(() => void stop(), lifetimeMs);
  async function stop() {
    if (stopped) return done;
    stopped = true;
    clearTimeout(timer);
    server.close();
    client?.destroy();
    ws?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child!.once("close", () => resolve()),
      );
      child.kill("SIGTERM");
      const kill = setTimeout(() => child?.kill("SIGKILL"), 1000);
      await exited;
      clearTimeout(kill);
    }
    finish();
  }
  async function attach() {
    // Loopback CDP exists ONLY in this worker's separate network namespace.
    const port = 9222;
    child = spawn(
      executablePath,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--cdp-max-connections",
        "1",
        "--load-resources",
        "iframe",
        "--disable-metrics",
      ],
      {
        env: browserEnvironment(),
        cwd: "/tmp",
        stdio: "ignore",
      },
    );
    child.once("error", () => void stop());
    child.once("exit", () => void stop());
    const deadline = Date.now() + 10000;
    let endpoint: string | undefined;
    while (!stopped && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(500),
          redirect: "error",
        });
        const data = (await response.json()) as {
          webSocketDebuggerUrl?: string;
        };
        const url = new URL(data.webSocketDebuggerUrl ?? "");
        if (
          url.protocol !== "ws:" ||
          url.hostname !== "127.0.0.1" ||
          url.port !== String(port) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
        endpoint = url.href;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!endpoint || stopped) throw new Error("Browser unavailable");
    ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP timeout")), 3000);
      ws!.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      ws!.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("CDP failed"));
      };
    });
    if (stopped) {
      ws.close();
      return;
    }
    ws.onclose = () => void stop();
    ws.onerror = () => void stop();
    ws.onmessage = (event) => {
      try {
        if (typeof event.data !== "string") throw new Error();
        writeFrame(client!, event.data);
      } catch {
        void stop();
      }
    };
    readFrames(client!, (message) => {
      if (
        ws!.readyState !== WebSocket.OPEN ||
        ws!.bufferedAmount > MAX_CDP_BYTES
      ) {
        void stop();
        return;
      }
      ws!.send(message);
    });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    await stop();
    throw error;
  }
  return { stop, done };
}

if (import.meta.main) {
  const worker = await runWorker(
    process.argv[2] ?? "/ipc/browser.sock",
    "/usr/local/bin/lightpanda",
  );
  process.once("SIGTERM", () => void worker.stop());
  process.once("SIGINT", () => void worker.stop());
  await worker.done;
}
