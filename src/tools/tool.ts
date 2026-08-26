import type { ZodRawShape, objectOutputType, ZodTypeAny } from "zod";

import type { BindingPolicy } from "../broker/binding.js";
import type { SecretsClient } from "../broker/secrets-client.js";
import type { BrowserSession } from "../browser/session.js";
import type { RedactionRegistry } from "../redaction/registry.js";

/** Shared wiring every tool handler receives. */
export type ToolContext = {
  secrets: SecretsClient;
  session: BrowserSession;
  registry: RedactionRegistry;
  binding: BindingPolicy;
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
