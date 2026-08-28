import { z } from "zod";

import { ConsensusPendingError } from "../broker/secrets-client.js";
import { injectResolved, validateTargets } from "./fill-common.js";
import { defineTool } from "./tool.js";

export const awaitFill = defineTool({
  name: "await_fill",
  description:
    "Complete a fill_secret that returned pending_approval. Waits for the " +
    "consensus export to be approved, re-validates the destination against " +
    "the live page, and injects. Returns pending_approval again if the " +
    "timeout passes first — call again later; the fill stays valid.",
  inputSchema: {
    fill_id: z.string().describe("fill_id from a pending fill_secret result"),
    timeout_seconds: z
      .number()
      .int()
      .min(1)
      .max(120)
      .default(30)
      .describe("How long to wait for approval before returning pending"),
  },
  handler: async (ctx, args) => {
    const fill = ctx.pendingFills.get(args.fill_id);
    if (!fill) throw new Error(`Unknown fill_id: ${args.fill_id}`);
    const ref = fill.pending.ref;

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
          filled: false,
          status: "pending_approval",
          fill_id: fill.fillId,
          secret_id: ref.secretId,
          activity_id: fill.pending.activityId,
          message: "Still awaiting approval. Call await_fill again.",
        };
      }
      ctx.pendingFills.delete(fill.fillId);
      throw err;
    }
    ctx.pendingFills.delete(fill.fillId);

    // Approval took wall-clock time; the page may have moved. Re-resolve
    // every element and re-check the binding against the live page before
    // the plaintext goes anywhere. If a target is gone, the value is dropped
    // — never redirected to a "close enough" field.
    let resolved;
    try {
      resolved = await validateTargets(ctx, ref, fill.targets);
    } catch (err) {
      exported.release();
      if (err instanceof Error && /Unknown element uid/i.test(err.message)) {
        throw new Error(
          "A target element is no longer available (the page changed while " +
            "awaiting approval). Snapshot again and start a new fill_secret.",
        );
      }
      throw err;
    }

    await injectResolved(ctx, exported, resolved);
    return {
      filled: true,
      secret_id: ref.secretId,
      element_uids: fill.targets.map((t) => t.elementUid),
    };
  },
});
