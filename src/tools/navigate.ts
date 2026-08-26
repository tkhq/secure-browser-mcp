import { z } from "zod";

import { defineTool, NotImplementedError } from "./tool.js";

export const navigate = defineTool({
  name: "navigate",
  description: "Navigate the broker-owned browser to a URL.",
  inputSchema: {
    url: z.string().url(),
  },
  handler: async (_ctx, _args) => {
    // ensureStarted() → page.goto(url) → return { url, title }.
    throw new NotImplementedError("navigate");
  },
});
