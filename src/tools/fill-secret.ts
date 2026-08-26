import { z } from "zod";

import type { FillTarget } from "../broker/types.js";
import { injectSecret } from "../browser/inject.js";
import { defineTool } from "./tool.js";

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
  handler: async (ctx, args) => {
    // 1. Resolve the ref.
    const refs = await ctx.secrets.listRefs();
    const ref = refs.find((r) => r.secretId === args.secret_id);
    if (!ref) throw new Error(`Unknown secret: ${args.secret_id}`);

    // 2. Resolve the target element on the live page.
    const page = await ctx.session.ensureStarted();
    const element = ctx.session.resolveElement(args.element_uid);
    const selectorInfo = await element.handle.evaluate((el) => {
      const input = el as HTMLInputElement;
      return `${el.tagName.toLowerCase()}${input.type ? `[type=${input.type}]` : ""}`;
    });
    const target: FillTarget = {
      pageUrl: page.url(),
      elementUid: args.element_uid,
      selectorInfo,
    };

    // 3. Prompt-injection gate: the live page must match the binding baked
    //    into the secret's static properties at import time.
    await ctx.binding.assertAllowed(ref, target, {
      elementMatches: (selector) =>
        element.handle.evaluate((el, sel) => el.matches(sel), selector),
    });

    // 4. TODO: human confirmation (elicitation / MCP App) — later milestone.

    // 5. Export: plaintext lands in broker memory only.
    const exported = await ctx.secrets.exportSecret(ref);

    // 6. Inject via CDP; registers with the redaction registry BEFORE the
    //    value touches the page, then drops the value.
    await injectSecret(ctx.session, target, exported, ctx.registry);

    // Outcome only — never the value.
    return {
      filled: true,
      secret_id: ref.secretId,
      element_uid: target.elementUid,
    };
  },
});
