import { z } from "zod";

import { defineTool, NotImplementedError } from "./tool.js";

export const typeText = defineTool({
  name: "type_text",
  description:
    "Type non-secret text into an element. For secrets, use fill_secret — " +
    "passing a secret value here would expose it to the conversation.",
  inputSchema: {
    element_uid: z.string(),
    text: z.string(),
  },
  handler: async (_ctx, _args) => {
    throw new NotImplementedError("type_text");
  },
});
