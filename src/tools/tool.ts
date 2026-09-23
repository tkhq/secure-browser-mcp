import type { ZodRawShape, objectOutputType, ZodTypeAny } from "zod";

import type { BindingPolicy } from "../broker/binding.js";
import type { PendingFills } from "../broker/pending-store.js";
import type { SecretsClient } from "../broker/secrets-client.js";
import type { BrowserSession } from "../browser/session.js";
import type { RedactionRegistry } from "../redaction/registry.js";

export type { PendingFill } from "../broker/pending-store.js";

/**
 * Shared wiring every tool handler receives. One context per agent session:
 * `session`, `registry`, and `pendingFills` belong to that session alone;
 * `secrets` and `binding` are shared by every session of the broker.
 */
export type ToolContext = {
  secrets: SecretsClient;
  backend: "mock" | "turnkey";
  session: BrowserSession;
  registry: RedactionRegistry;
  binding: BindingPolicy;
  /** This session's parked fills (see src/broker/pending-store.ts). */
  pendingFills: PendingFills;
  /** Dashboard link for an approval-gated activity; undefined when the
   * backend has no dashboard (mock) or the API host is unknown. */
  approvalUrl?: (activityId: string) => string | undefined;
};

/**
 * Tool results are plain JSON values. `server.ts` owns serialization: every
 * result passes through `scrub()` and is wrapped into MCP content there —
 * handlers cannot write to the transport directly.
 */
export type ToolDef<Shape extends ZodRawShape = ZodRawShape> = {
  name: string;
  description: string;
  inputSchema: Shape;
  handler: (
    ctx: ToolContext,
    args: objectOutputType<Shape, ZodTypeAny>,
  ) => Promise<unknown>;
};

/** Type-erased view for the heterogeneous tool registry in server.ts. */
export type AnyToolDef = {
  name: string;
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
