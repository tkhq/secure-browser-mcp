import { connect, type Socket } from "node:net";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ConnectionTransport } from "puppeteer-core";

export const MAX_CDP_BYTES = 4 * 1024 * 1024;

/** Bounded newline framing; CDP JSON strings escape embedded newlines. */
export function readFrames(socket: Socket, receive: (message: string) => void) {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      if (Buffer.byteLength(pending.slice(0, end)) > MAX_CDP_BYTES) {
        socket.destroy();
        return;
      }
      const message = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const parsed = JSON.parse(message);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error();
        receive(message);
      } catch {
        socket.destroy();
        return;
      }
    }
    if (Buffer.byteLength(pending) > MAX_CDP_BYTES) socket.destroy();
  });
}

export function writeFrame(socket: Socket, message: string) {
  if (
    socket.destroyed ||
    message.includes("\n") ||
    Buffer.byteLength(message) > MAX_CDP_BYTES ||
    socket.writableLength > MAX_CDP_BYTES
  ) {
    socket.destroy();
    throw new Error("Worker transport unavailable");
  }
  socket.write(message + "\n");
}

/** The directory is a dedicated IPC volume, never a broker state directory. */
export async function validateSocketDirectory(path: string) {
  if (!isAbsolute(path) || Buffer.byteLength(path) > 100)
    throw new Error("Invalid worker socket path");
  const directory = await lstat(dirname(path));
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== process.getuid?.()
  ) {
    throw new Error(
      "Worker socket directory must be owned by this UID with mode 0700",
    );
  }
}

export class WorkerTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private constructor(private readonly socket: Socket) {
    readFrames(socket, (message) => this.onmessage?.(message));
    socket.on("error", () => {}); // Never expose CDP or path contents in logs.
    socket.once("close", () => this.onclose?.());
  }
  static async open(path: string): Promise<WorkerTransport> {
    await validateSocketDirectory(path);
    const file = await lstat(path);
    if (
      !file.isSocket() ||
      (file.mode & 0o777) !== 0o600 ||
      file.uid !== process.getuid?.()
    )
      throw new Error("Untrusted worker socket");
    const socket = connect(path);
    const transport = new WorkerTransport(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Worker connection timed out"));
      }, 5000);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Worker connection failed"));
      });
    });
    return transport;
  }
  send(message: string) {
    writeFrame(this.socket, message);
  }
  close() {
    this.socket.destroy();
  }
}
