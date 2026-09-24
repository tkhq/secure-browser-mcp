import { z } from "zod";

import { ConsensusPendingError } from "../broker/secrets-client.js";
import {
  injectResolved,
  specsFromArgs,
  targetArgs,
  validateTargets,
} from "./fill-common.js";
import { pendingResult } from "./fill-secret.js";
import { defineTool, type PendingFill, type ToolContext } from "./tool.js";

export const awaitFill = defineTool({
  name: "await_fill",
  description:
    "Complete a fill_secret that returned pending_approval. Waits for the " +
    "consensus export to be approved, re-validates the destination against " +
    "the live page, and injects. Returns pending_approval again if the " +
    "timeout passes first — call again later; the fill stays valid. If the " +
    "original element uids are gone (the page reloaded or the broker " +
    "restarted), navigate back, snapshot, and pass the new element_uid or " +
    "fields with the same fill_id.",
  inputSchema: {
    fill_id: z.string().describe("fill_id from a pending fill_secret result"),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(120)
      .default(30)
      .describe("How long to wait for approval before returning pending"),
    ...targetArgs,
  },
  handler: async (ctx, args) => {
    const fill = await ctx.pendingFills.get(args.fill_id);
    if (!fill) throw new Error(`Unknown fill_id: ${args.fill_id}`);
    const ref = fill.pending.ref;

    // New destinations replace the parked ones. They pass the same binding
    // checks, so this lets the agent point at a fresh snapshot, not at a
    // destination fill_secret would refuse.
    if (args.element_uid !== undefined || args.fields !== undefined) {
      const specs = specsFromArgs(args);
      if (!specs)
        throw new Error("Provide at most one of element_uid or fields");
      fill.targets = specs;
      await ctx.pendingFills.put(fill);
    }

    // Check the destination before waiting, so a stale page is reported
    // now rather than after the approver acts. The fill stays parked.
    await validateOrExplain(ctx, fill);

    // Wait for quorum. Timeout is not failure: report pending and keep the
    // fill; rejection or backend failure kills it.
    let exported;
    try {
      exported = await ctx.secrets.awaitExport(
        fill.pending,
        args.timeout_seconds * 1_000,
      );
    } catch (err) {
      if (err instanceof ConsensusPendingError) {
        return {
          ...pendingResult(ctx, fill),
          message:
            "Still awaiting approval. Remind the approver of the link if " +
            "needed, then call await_fill again.",
        };
      }
      await ctx.pendingFills.delete(fill.fillId);
      throw err;
    }

    // Approval took wall-clock time; the page may have moved. Re-resolve
    // every element and re-check the binding against the live page before
    // the plaintext goes anywhere. If a target is gone, the value is dropped
    // (never redirected to a "close enough" field) and the fill stays
    // parked: the approved export can be redeemed again into new targets.
    let resolved;
    try {
      resolved = await validateOrExplain(ctx, fill);
    } catch (err) {
      exported.release();
      throw err;
    }

    await injectResolved(ctx, exported, resolved);
    await ctx.pendingFills.delete(fill.fillId);
    return {
      filled: true,
      secret_id: ref.secretId,
      element_uids: fill.targets.map((t) => t.elementUid),
    };
  },
});

async function validateOrExplain(ctx: ToolContext, fill: PendingFill) {
  try {
    return await validateTargets(ctx, fill.pending.ref, fill.targets);
  } catch (err) {
    if (err instanceof Error && /Unknown element uid/i.test(err.message)) {
      throw new Error(
        "A target element is no longer available (the page changed or the " +
          `broker restarted). Navigate to ${fill.pageUrl} if needed, take a ` +
          "snapshot, and call await_fill again with this fill_id and the " +
          "new element_uid or fields.",
      );
    }
    throw err;
  }
}
