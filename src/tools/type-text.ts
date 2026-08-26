import { z } from "zod";

import { defineTool } from "./tool.js";

export const typeText = defineTool({
  name: "type_text",
  description:
    "Type non-secret text into an element. For secrets, use fill_secret — " +
    "passing a secret value here would expose it to the conversation.",
  inputSchema: {
    element_uid: z.string(),
    text: z.string(),
  },
  handler: async (ctx, args) => {
    await ctx.session.ensureStarted();
    const element = ctx.session.resolveElement(args.element_uid);
    await element.handle.click();
    await element.handle.type(args.text);
    return { typed: args.element_uid, length: args.text.length };
  },
});
