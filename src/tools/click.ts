import { z } from "zod";

import { defineTool } from "./tool.js";

export const click = defineTool({
  name: "click",
  description: "Click an element identified by its snapshot uid.",
  inputSchema: {
    element_uid: z.string(),
  },
  handler: async (ctx, args) => {
    await ctx.session.ensureStarted();
    const element = ctx.session.resolveElement(args.element_uid);
    try {
      await element.handle.click();
    } catch {
      // Custom-styled controls often hide the real input (zero-size or
      // opacity 0), which defeats a coordinate click. Fall back to a DOM
      // click — broker-authored fixed code, not agent-supplied script.
      await element.handle.evaluate((el) => (el as HTMLElement).click());
    }
    return { clicked: args.element_uid };
  },
});
