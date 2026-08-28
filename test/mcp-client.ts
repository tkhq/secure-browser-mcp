/**
 * Black-box MCP stdio client for the e2e tests: spawns the real server as a
 * subprocess and records every byte it writes to stdout for leak assertions.
 */

export type JsonRpcMessage = {
  id?: number;
  result?: {
    tools?: { name: string }[];
    isError?: boolean;
    content?: { type: string; text: string }[];
  };
  error?: { message: string };
};

export class McpStdioClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: JsonRpcMessage) => void>();
  /** Every byte the server ever wrote to stdout, for leak assertions. */
  transcript = "";

  constructor(env: Record<string, string> = {}) {
    this.proc = Bun.spawn(["bun", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, SBM_HEADLESS: "true", ...env },
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    for await (const chunk of this.proc.stdout) {
      const text = new TextDecoder().decode(chunk);
      this.transcript += text;
      this.buffer += text;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as JsonRpcMessage;
        if (msg.id !== undefined) {
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        }
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    this.proc.stdin.write(JSON.stringify(payload) + "\n");
  }

  request(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const done = new Promise<JsonRpcMessage>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout: ${method}`)), 30_000);
    });
    this.send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return done;
  }

  notify(method: string): void {
    this.send({ jsonrpc: "2.0", method });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "0" },
    });
    this.notify("notifications/initialized");
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; body: unknown; text: string }> {
    const msg = await this.request("tools/call", { name, arguments: args });
    const text = msg.result?.content?.[0]?.text ?? "";
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { isError: msg.result?.isError === true, body, text };
  }

  async stop(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}
