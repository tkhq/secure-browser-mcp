import { randomUUID } from "node:crypto";

import { z } from "zod";

import { ConsensusNeededError } from "../broker/secrets-client.js";
import {
  injectResolved,
  specsFromArgs,
  targetArgs,
  validateTargets,
  type FillFieldSpec,
} from "./fill-common.js";
import { defineTool, type PendingFill, type ToolContext } from "./tool.js";

export function pendingResult(ctx: ToolContext, fill: PendingFill) {
  const activityId = fill.pending.activityId;
  const approvalUrl = ctx.approvalUrl?.(activityId);
  const where =
    approvalUrl ?? `activity ${activityId} in the Turnkey dashboard`;
  return {
    filled: false,
    status: "pending_approval",
    fill_id: fill.fillId,
    secret_id: fill.pending.ref.secretId,
    activity_id: activityId,
    ...(approvalUrl ? { approval_url: approvalUrl } : {}),
    page_url: fill.pageUrl,
    ...(fill.intent !== undefined ? { intent: fill.intent } : {}),
    approver_note: approverNote(fill, where),
    message:
      "Export requires consensus approval. Send the approver the " +
      "approver_note, which includes this exact link to approve: " +
      `${where}. Then call await_fill with this fill_id. Keep the page ` +
      "where it is: the fill re-validates the destination before injecting.",
  };
}

/**
 * Review context for the approver, human or automated. The broker states
 * the facts it checked (secret, page) and keeps the agent's intent apart
 * from them, labeled as unverified: a prompt-injected agent can state any
 * intent, but it cannot change the page the binding matched.
 */
function approverNote(fill: PendingFill, where: string): string {
  const ref = fill.pending.ref;
  const secret = ref.name ? `"${ref.name}"` : ref.secretId;
  const intent =
    fill.intent !== undefined
      ? `Intent stated by the agent (not verified): "${fill.intent}".`
      : "The agent stated no intent.";
  return (
    `Approve the export of secret ${secret} to fill a form on ` +
    `${fill.pageUrl}. The broker checked that this page matches the ` +
    `secret's destination binding. ${intent} Approve at: ${where}`
  );
}

function specsKey(secretId: string, specs: FillFieldSpec[]): string {
  const parts = specs.map((s) => `${s.key ?? ""}:${s.elementUid}`).sort();
  return `${secretId}|${parts.join(",")}`;
}

export const fillSecret = defineTool({
  name: "fill_secret",
  scope: "sbm:fill",
  browser: true,
  description:
    "Fill a secret into form fields, by reference. The secret value is " +
    "exported from Turnkey, injected via CDP, and never enters this " +
    "conversation. Fails unless the current page matches the secret's " +
    "destination binding. Single-value secrets fill one element_uid; a " +
    "JSON-payload secret (binding declares sbm:fields) fills several fields " +
    "in one call — one export, one approval. Pass intent so approvers " +
    "know why the export is requested.",
  inputSchema: {
    secret_id: z.string().describe("secretId from list_secret_refs"),
    ...targetArgs,
    intent: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Why this fill is needed, in one or two plain sentences, for the " +
          'approvers who review a consensus-gated export (e.g. "Log in to ' +
          'GitHub to rotate the deploy key, as the user asked"). Never put ' +
          "secret values here.",
      ),
  },
  handler: async (ctx, args) => {
    // 1. Resolve the ref.
    const refs = await ctx.secrets.listRefs();
    const ref = refs.find((r) => r.secretId === args.secret_id);
    if (!ref) throw new Error(`Unknown secret: ${args.secret_id}`);

    // 2. Normalize the requested destinations.
    const specs = specsFromArgs(args);
    if (!specs) throw new Error("Provide exactly one of element_uid or fields");

    // 3. Prompt-injection gate: the live page and every element must match
    //    the binding baked into the secret's static properties at import.
    const validated = await validateTargets(ctx, ref, specs);

    // 4. TODO: human confirmation (elicitation / MCP App) — later milestone.
    //    A cancel frees this request's id while the handler still runs, so
    //    check the request's `signal.aborted` (from the SDK's handler
    //    context, which server.ts does not pass to tools yet) before each
    //    elicitation or related notification. Otherwise it can reach a new
    //    request that reuses the id (src/inflight.ts).

    // 5. Idempotency, BEFORE any export attempt: re-requesting a fill that
    //    is already parked on approval returns the same handle. Checking
    //    after the export would submit a duplicate proposal every retry.
    //    (If the parked activity was meanwhile rejected, await_fill reports
    //    that and clears the entry, and the next fill_secret starts fresh.)
    //    The parked fill keeps the intent of the call that parked it.
    const requestKey = specsKey(ref.secretId, specs);
    const existing = ctx.pendingFills
      .list()
      .find((f) => specsKey(f.pending.ref.secretId, f.targets) === requestKey);
    if (existing) return pendingResult(ctx, existing);

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
          pageUrl: validated.pageUrl,
          ...(args.intent !== undefined ? { intent: args.intent } : {}),
          createdAt: Date.now(),
        };
        await ctx.pendingFills.put(fill);
        return pendingResult(ctx, fill);
      }
      throw err;
    }

    // 7. Inject via CDP. Each target is authorized again just before its
    //    write and must still be the destination checked in step 3; each
    //    part registers with the redaction registry BEFORE the value
    //    touches the page, then the value is dropped.
    await injectResolved(ctx, exported, validated);

    // Outcome only — never the value.
    return {
      filled: true,
      secret_id: ref.secretId,
      element_uids: specs.map((s) => s.elementUid),
    };
  },
});
