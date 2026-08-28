import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ConsensusNeededError } from "../broker/secrets-client.js";
import {
  injectResolved,
  validateTargets,
  type FillFieldSpec,
} from "./fill-common.js";
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

function specsKey(secretId: string, specs: FillFieldSpec[]): string {
  const parts = specs.map((s) => `${s.key ?? ""}:${s.elementUid}`).sort();
  return `${secretId}|${parts.join(",")}`;
}

export const fillSecret = defineTool({
  name: "fill_secret",
  description:
    "Fill a secret into form fields, by reference. The secret value is " +
    "exported from Turnkey, injected via CDP, and never enters this " +
    "conversation. Fails unless the current page matches the secret's " +
    "destination binding. Single-value secrets fill one element_uid; a " +
    "JSON-payload secret (binding declares sbm:fields) fills several fields " +
    "in one call — one export, one approval.",
  inputSchema: {
    secret_id: z.string().describe("secretId from list_secret_refs"),
    element_uid: z
      .string()
      .optional()
      .describe(
        "Element uid of the target field (single-value secrets), from the " +
          "latest snapshot",
      ),
    fields: z
      .array(
        z.object({
          key: z.string().describe("Payload key from the binding's sbm:fields"),
          element_uid: z.string().describe("Target element uid"),
        }),
      )
      .optional()
      .describe(
        "For JSON-payload secrets: which payload key goes into which " +
          "element. Provide instead of element_uid.",
      ),
  },
  handler: async (ctx, args) => {
    // 1. Resolve the ref.
    const refs = await ctx.secrets.listRefs();
    const ref = refs.find((r) => r.secretId === args.secret_id);
    if (!ref) throw new Error(`Unknown secret: ${args.secret_id}`);

    // 2. Normalize the requested destinations.
    if (!args.element_uid === !args.fields) {
      throw new Error("Provide exactly one of element_uid or fields");
    }
    const specs: FillFieldSpec[] = args.fields
      ? args.fields.map((f) => ({ key: f.key, elementUid: f.element_uid }))
      : [{ elementUid: args.element_uid! }];

    // 3. Prompt-injection gate: the live page and every element must match
    //    the binding baked into the secret's static properties at import.
    const resolved = await validateTargets(ctx, ref, specs);

    // 4. TODO: human confirmation (elicitation / MCP App) — later milestone.

    // 5. Idempotency, BEFORE any export attempt: re-requesting a fill that
    //    is already parked on approval returns the same handle. Checking
    //    after the export would submit a duplicate proposal every retry.
    //    (If the parked activity was meanwhile rejected, await_fill reports
    //    that and clears the entry, and the next fill_secret starts fresh.)
    const requestKey = specsKey(ref.secretId, specs);
    const existing = [...ctx.pendingFills.values()].find(
      (f) => specsKey(f.pending.ref.secretId, f.targets) === requestKey,
    );
    if (existing) return pendingResult(existing);

    // 6. Export: plaintext lands in broker memory only. A consensus-gated
    //    export parks the fill instead of failing it: the broker keeps the
    //    decryption key and the targets, hands the agent an opaque fill id,
    //    and await_fill completes the fill once approvers reach quorum.
    let exported;
    try {
      exported = await ctx.secrets.exportSecret(ref);
    } catch (err) {
      if (err instanceof ConsensusNeededError && err.pending) {
        const fill: PendingFill = {
          fillId: randomUUID(),
          pending: err.pending,
          targets: specs,
          pageUrl: resolved[0]!.target.pageUrl,
          createdAt: Date.now(),
        };
        ctx.pendingFills.set(fill.fillId, fill);
        return pendingResult(fill);
      }
      throw err;
    }

    // 7. Inject via CDP; each part registers with the redaction registry
    //    BEFORE the value touches the page, then the value is dropped.
    await injectResolved(ctx, exported, resolved);

    // Outcome only — never the value.
    return {
      filled: true,
      secret_id: ref.secretId,
      element_uids: specs.map((s) => s.elementUid),
    };
  },
});
