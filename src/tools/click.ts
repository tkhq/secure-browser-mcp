import { z } from "zod";

import { defineTool, NotImplementedError } from "./tool.js";

export const click = defineTool({
  name: "click",
  description: "Click an element identified by its snapshot uid.",
  inputSchema: {
    element_uid: z.string(),
  },
  handler: async (_ctx, _args) => {
    throw new NotImplementedError("click");
  },
});
