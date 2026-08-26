import { defineTool } from "./tool.js";

export const listSecretRefs = defineTool({
  name: "list_secret_refs",
  description:
    "List the secrets available to fill, as opaque references: id, name, and " +
    "destination binding (origin/url pattern/selector). Secret values are " +
    "never returned by any tool.",
  inputSchema: {},
  handler: async (ctx) => {
    const refs = await ctx.secrets.listRefs();
    return { refs };
  },
});
