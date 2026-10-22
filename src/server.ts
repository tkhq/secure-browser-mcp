import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { RedactionRegistry } from "@turnkey/browser-secrets";
import { z } from "zod";

import { awaitFill } from "./tools/await-fill.js";
import {
  browserIdArg,
  closeBrowser,
  openBrowser,
} from "./tools/browser-handles.js";
import { click } from "./tools/click.js";
import { fillSecret } from "./tools/fill-secret.js";
import { listNetwork } from "./tools/list-network.js";
import { listSecretRefs } from "./tools/list-secret-refs.js";
import { navigate } from "./tools/navigate.js";
import { snapshot } from "./tools/snapshot.js";
import { typeText } from "./tools/type-text.js";
import type { AnyToolDef, BrokerContext } from "./tools/tool.js";

// Deliberate absence: there is no evaluate_script tool. Agent-authored page
// JS could hook input events and exfiltrate a secret before or after a fill,
// so script evaluation is excluded from the tool surface by design — see
// docs/DESIGN.md and docs/THREAT-MODEL.md before adding anything here.
export const TOOLS: AnyToolDef[] = [
  openBrowser,
  closeBrowser,
  listSecretRefs,
  navigate,
  snapshot,
  click,
  typeText,
  fillSecret,
  awaitFill,
  listNetwork,
];

export function createServer(ctx: BrokerContext): McpServer {
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
      // and z.object() is what v1 wrapped them in. Every browser tool takes
      // browser_id; the handler never sees it.
      {
        description: tool.description,
        inputSchema: z.object(
          tool.browser
            ? { ...tool.inputSchema, browser_id: browserIdArg }
            : tool.inputSchema,
        ),
      },
      async (input: Record<string, unknown>) => {
        const { browser_id, ...rest } = input;
        const args = tool.browser ? rest : input;
        // Errors are scrubbed with the registry of the browser the call
        // ran in. One that fails before reaching a browser (an unknown
        // browser_id) has no secret to scrub.
        let registry = new RedactionRegistry();
        try {
          // Single choke point: every result — success or error — passes
          // through registry.scrub() before it reaches the transport. Args
          // were already validated against the tool's zod shape by the SDK.
          const result = await ctx.browsers.run(
            tool.browser ? (browser_id as string | undefined) : undefined,
            tool.browser,
            async (browser) => {
              registry = browser.registry;
              const out = await tool.handler(
                { ...ctx, ...browser },
                args as never,
              );
              return browser.registry.scrub(out);
            },
          );
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
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
                text: registry.scrubText(message),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}
