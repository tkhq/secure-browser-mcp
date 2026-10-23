import type { ZodObject, ZodRawShape, output } from "zod";

import type { Scope } from "../auth/scopes.js";
import type { SecretsClient } from "../broker/secrets-client.js";
import type { BrowserContext, BrowserScope } from "../browsers.js";

export type { PendingFill } from "../broker/pending-store.js";

/** The broker side of a tool call: shared by every browser. */
export type BrokerContext = {
  secrets: SecretsClient;
  backend: "mock" | "turnkey";
  /** The browsers this connection's caller can open, reach, and close. */
  browsers: BrowserScope;
  /** Dashboard link for an approval-gated activity; undefined when the
   * backend has no dashboard (mock) or the API host is unknown. */
  approvalUrl?: (activityId: string) => string | undefined;
};

/**
 * Shared wiring every tool handler receives. `session`, `registry`, and
 * `pendingFills` belong to one browser: the one the call's `browser_id`
 * names, or the connection's own (src/browsers.ts). `secrets` is shared by
 * every browser of the broker.
 */
export type ToolContext = BrokerContext &
  BrowserContext & { signal?: AbortSignal };

export function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Request cancelled");
}

/**
 * Tool results are plain JSON values. `server.ts` owns serialization: every
 * result passes through `registry.scrub()` and is wrapped into MCP content there —
 * handlers cannot write to the transport directly.
 */
export type ToolDef<Shape extends ZodRawShape = ZodRawShape> = {
  name: string;
  /** The OAuth scope a hosted caller needs for this tool. */
  scope: Scope;
  /** Whether the tool acts on a browser. server.ts gives such a tool a
   * `browser_id` argument and runs it in that browser. */
  browser: boolean;
  description: string;
  inputSchema: Shape;
  handler: (
    ctx: ToolContext,
    args: output<ZodObject<Shape>>,
  ) => Promise<unknown>;
};

/** Type-erased view for the heterogeneous tool registry in server.ts. */
export type AnyToolDef = {
  name: string;
  scope: Scope;
  browser: boolean;
  description: string;
  inputSchema: ZodRawShape;
  handler: (ctx: ToolContext, args: never) => Promise<unknown>;
};

export function defineTool<Shape extends ZodRawShape>(
  def: ToolDef<Shape>,
): ToolDef<Shape> {
  return def;
}

/** Uniform shape for scaffold stubs. */
export class NotImplementedError extends Error {
  constructor(tool: string) {
    super(`not_implemented: ${tool} (scaffold stub)`);
    this.name = "NotImplementedError";
  }
}
