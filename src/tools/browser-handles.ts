import { z } from "zod";

import { UnknownBrowserError } from "../browsers.js";
import { defineTool } from "./tool.js";

/** The `browser_id` argument server.ts adds to every browser tool. */
export const browserIdArg = z
  .string()
  .optional()
  .describe(
    "browser_id from open_browser. Required on connections that have no " +
      "browser of their own (MCP 2026-07-28); on a 2025-era session, omit " +
      "it to use the session's own browser.",
  );

export const openBrowser = defineTool({
  name: "open_browser",
  scope: "sbm:browse",
  browser: false,
  description:
    "Open a broker-owned browser and return its browser_id. Pass the " +
    "browser_id to every browser tool (navigate, snapshot, click, " +
    "type_text, fill_secret, await_fill) to act in that browser, from any " +
    "connection of the same caller. Call close_browser when done; an " +
    "unused browser also closes after its idle timeout.",
  inputSchema: {},
  handler: async (ctx) => {
    const browserId = ctx.browsers.open();
    return {
      browser_id: browserId,
      idle_timeout_seconds: ctx.browsers.idleSeconds,
    };
  },
});

export const closeBrowser = defineTool({
  name: "close_browser",
  scope: "sbm:browse",
  browser: false,
  description:
    "Close a browser opened with open_browser. Its pages and element uids " +
    "are gone. A fill still pending approval stays redeemable: pass its " +
    "fill_id to await_fill in another browser.",
  inputSchema: {
    browser_id: z.string().describe("browser_id from open_browser"),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.browsers.close(args.browser_id))) {
      throw new UnknownBrowserError(args.browser_id);
    }
    return { closed: args.browser_id };
  },
});
