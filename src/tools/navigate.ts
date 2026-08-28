import { z } from "zod";

import { defineTool } from "./tool.js";

export const navigate = defineTool({
  name: "navigate",
  description: "Navigate the broker-owned browser to a URL.",
  inputSchema: {
    url: z.string().url(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.session.ensureStarted();
    await page.goto(args.url, { waitUntil: "load" });
    return { url: page.url(), title: await page.title() };
  },
});
