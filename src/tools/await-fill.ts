import { z } from "zod";

import { ConsensusPendingError } from "../broker/secrets-client.js";
import type { FillTarget } from "../broker/types.js";
import { injectSecret } from "../browser/inject.js";
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

    // Approval took wall-clock time; the page may have moved. Re-resolve the
    // element and re-check the binding against the live page before the
    // plaintext goes anywhere. If the target is gone, the value is dropped —
    // never redirected to a "close enough" field.
    const page = await ctx.session.ensureStarted();
    let element;
    try {
      element = ctx.session.resolveElement(fill.elementUid);
    } catch {
      exported.release();
      throw new Error(
        "The target element is no longer available (the page changed while " +
          "awaiting approval). Snapshot again and start a new fill_secret.",
      );
    }
    const selectorInfo = await element.handle.evaluate((el) => {
      const input = el as HTMLInputElement;
      return `${el.tagName.toLowerCase()}${input.type ? `[type=${input.type}]` : ""}`;
    });
    const target: FillTarget = {
      pageUrl: page.url(),
      elementUid: fill.elementUid,
      selectorInfo,
    };
    try {
      await ctx.binding.assertAllowed(ref, target, {
        elementMatches: (selector) =>
          element.handle.evaluate((el, sel) => el.matches(sel), selector),
      });
    } catch (err) {
      exported.release();
      throw err;
    }

    await injectSecret(ctx.session, target, exported, ctx.registry);
    return {
      filled: true,
      secret_id: ref.secretId,
      element_uid: target.elementUid,
    };
  },
});
