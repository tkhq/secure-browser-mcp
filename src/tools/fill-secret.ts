import { z } from "zod";

import { defineTool, NotImplementedError } from "./tool.js";

export const fillSecret = defineTool({
  name: "fill_secret",
  description:
    "Fill a secret into a form field, by reference. The secret value is " +
    "exported from Turnkey, injected via CDP, and never enters this " +
    "conversation. Fails unless the current page matches the secret's " +
    "destination binding.",
  inputSchema: {
    secret_id: z.string().describe("secretId from list_secret_refs"),
    element_uid: z
      .string()
      .describe("Element uid of the target field, from the latest snapshot"),
  },
  handler: async (_ctx, _args) => {
    // The full flow this stub will become (see docs/DESIGN.md):
    //   1. resolve secret_id → SecretRef (ctx.secrets.listRefs)
    //   2. resolve element_uid against the live page; build FillTarget
    //   3. ctx.binding.assertAllowed(ref, target)  ← prompt-injection gate
    //   4. optional human confirmation (elicitation / MCP App)
    //   5. exported = await ctx.secrets.exportSecret(ref)
    //      (ConsensusNeededError → return a pending task handle)
    //   6. injectSecret(page, target, exported, ctx.registry)
    //   → return { filled: true, secret_id, element_uid } — outcome only.
    throw new NotImplementedError("fill_secret");
  },
});
