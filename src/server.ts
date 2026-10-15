import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { scrub } from "./redaction/scrub.js";
import { awaitFill } from "./tools/await-fill.js";
import { click } from "./tools/click.js";
import { fillSecret } from "./tools/fill-secret.js";
import { listNetwork } from "./tools/list-network.js";
import { listSecretRefs } from "./tools/list-secret-refs.js";
import { navigate } from "./tools/navigate.js";
import { snapshot } from "./tools/snapshot.js";
import { typeText } from "./tools/type-text.js";
import type { AnyToolDef, ToolContext } from "./tools/tool.js";

// Deliberate absence: there is no evaluate_script tool. Agent-authored page
// JS could hook input events and exfiltrate a secret before or after a fill,
// so script evaluation is excluded from the tool surface by design — see
// docs/DESIGN.md and docs/THREAT-MODEL.md before adding anything here.
const TOOLS: AnyToolDef[] = [
  listSecretRefs,
  navigate,
  snapshot,
  click,
  typeText,
  fillSecret,
  awaitFill,
  listNetwork,
];

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: "secure-browser-mcp",
    version: "0.0.1",
  });

  // Erase registerTool's schema generic: each tool's args type is checked
  // in its own file by defineTool, and instantiating the generic here with a
  // heterogeneous registry adds nothing. Runtime validation against each
  // tool's schema is unaffected.
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: { description: string; inputSchema: z.ZodObject },
    cb: (args: Record<string, unknown>) => Promise<CallToolResult>,
  ) => void;

  for (const tool of TOOLS) {
    registerTool(
      tool.name,
      // v2 takes a schema object; the tools keep their v1-style raw shapes,
      // and z.object() is what v1 wrapped them in.
      {
        description: tool.description,
        inputSchema: z.object(tool.inputSchema),
      },
      async (args: Record<string, unknown>) => {
        try {
          // Single choke point: every result — success or error — passes
          // through scrub() before it reaches the transport. Args were
          // already validated against the tool's zod shape by the SDK.
          const result = await tool.handler(ctx, args as never);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(scrub(ctx.registry, result), null, 2),
              },
            ],
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: ctx.registry.scrubText(message),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}
