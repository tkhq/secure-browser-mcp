import { z } from "zod";

import type { SecretRef } from "../broker/types.js";
import { defineTool } from "./tool.js";

/** Origin match: exact, ignoring a trailing slash and case in the host. */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  }
}

export function selectRefs(
  refs: SecretRef[],
  args: { origin?: string | undefined; include_unbound?: boolean | undefined },
): SecretRef[] {
  return refs.filter((ref) => {
    if (!ref.binding) return args.include_unbound === true;
    if (args.origin) return sameOrigin(ref.binding.origin, args.origin);
    return true;
  });
}

export const listSecretRefs = defineTool({
  name: "list_secret_refs",
  description:
    "Report the active backend (mock or turnkey) and list the secrets available to fill, as opaque references: id, name, and " +
    "destination binding (origin/url pattern/selector). Pass origin to see only " +
    "the secrets bound to the site you are on. Secrets without a destination " +
    "binding cannot be filled and are hidden unless include_unbound is set. " +
    "Secret values are never returned by any tool.",
  inputSchema: {
    origin: z
      .string()
      .optional()
      .describe(
        "Only return secrets bound to this origin, e.g. https://buy.stripe.com " +
          "(the page you are about to fill on). Omit to list every bound secret.",
      ),
    include_unbound: z
      .boolean()
      .optional()
      .describe(
        "Also list secrets that carry no sbm:origin binding. They cannot be " +
          "filled; useful only to confirm a secret exists in the store.",
      ),
  },
  handler: async (ctx, args) => {
    const all = await ctx.secrets.listRefs();
    const refs = selectRefs(all, args);
    return {
      backend: ctx.backend,
      refs,
      ...(refs.length !== all.length
        ? { hidden: all.length - refs.length }
        : {}),
    };
  },
});
