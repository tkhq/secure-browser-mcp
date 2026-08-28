import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ConsensusNeededError } from "../broker/secrets-client.js";
import type { FillTarget } from "../broker/types.js";
import { injectSecret } from "../browser/inject.js";
import { defineTool, type PendingFill } from "./tool.js";

function pendingResult(fill: PendingFill) {
  return {
    filled: false,
    status: "pending_approval",
    fill_id: fill.fillId,
    secret_id: fill.pending.ref.secretId,
    activity_id: fill.pending.activityId,
    message:
      "Export requires consensus approval. Ask an approver to approve " +
      `activity ${fill.pending.activityId} (Turnkey dashboard), then ` +
      "call await_fill with this fill_id. Keep the page where it is: " +
      "the fill re-validates the destination before injecting.",
  };
}

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

    // 5. Idempotency, BEFORE any export attempt: re-requesting a fill that
    //    is already parked on approval returns the same handle. Checking
    //    after the export would submit a duplicate proposal every retry.
    //    (If the parked activity was meanwhile rejected, await_fill reports
    //    that and clears the entry, and the next fill_secret starts fresh.)
    const existing = [...ctx.pendingFills.values()].find(
      (f) =>
        f.pending.ref.secretId === ref.secretId &&
        f.elementUid === args.element_uid,
    );
    if (existing) return pendingResult(existing);

    // 6. Export: plaintext lands in broker memory only. A consensus-gated
    //    export parks the fill instead of failing it: the broker keeps the
    //    decryption key and the target, hands the agent an opaque fill id,
    //    and await_fill completes the fill once approvers reach quorum.
    let exported;
    try {
      exported = await ctx.secrets.exportSecret(ref);
    } catch (err) {
      if (err instanceof ConsensusNeededError && err.pending) {
        const fill: PendingFill = {
          fillId: randomUUID(),
          pending: err.pending,
          elementUid: args.element_uid,
          pageUrl: target.pageUrl,
          createdAt: Date.now(),
        };
        ctx.pendingFills.set(fill.fillId, fill);
        return pendingResult(fill);
      }
      throw err;
    }

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
