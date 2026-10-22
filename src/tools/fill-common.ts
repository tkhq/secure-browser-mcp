/**
 * Fill logic shared by fill_secret and await_fill: target authorization
 * against the binding, and plaintext fan-out for JSON multi-field secrets.
 *
 * The decision is @turnkey/browser-secrets `authorize`, on an observation
 * the browser layer reads from the live page (src/browser/observe.ts).
 * Callers authorize before export, and `injectResolved` authorizes each
 * target again immediately before its write and requires the same
 * destination (`isSameDestination`): the same tab, frame, document and
 * element that were checked.
 */
import {
  authorize,
  DENY_REASON_MESSAGES,
  isSameDestination,
  redactionEntries,
  validateRequest,
  type AuthorizationAllowed,
  type DenyReason,
  type FillRequest,
  type RedactionTarget,
} from "@turnkey/browser-secrets";
import { z } from "zod";

import type { ExportedSecret, SecretRef } from "../broker/types.js";
import { injectSecret, type FieldCheck } from "../browser/inject.js";
import { observeTargets } from "../browser/observe.js";
import type { ToolContext } from "./tool.js";

/** One requested destination: an element, plus the payload key for JSON
 * multi-field secrets (absent for plain single-value fills). */
export type FillFieldSpec = { key?: string; elementUid: string };

/** Destination arguments shared by fill_secret and await_fill. */
export const targetArgs = {
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
};

/** Normalize `targetArgs` into specs; undefined unless exactly one of
 * element_uid or fields is given. */
export function specsFromArgs(args: {
  element_uid?: string | undefined;
  fields?: { key: string; element_uid: string }[] | undefined;
}): FillFieldSpec[] | undefined {
  if (!args.element_uid === !args.fields) return undefined;
  return args.fields
    ? args.fields.map((f) => ({ key: f.key, elementUid: f.element_uid }))
    : [{ elementUid: args.element_uid! }];
}

/** Why a fill was refused: a browser-secrets deny reason, or a page that
 * changed between the check and the write. */
export type FillDenyReason = DenyReason | "destination_changed";

const DESTINATION_CHANGED =
  "The page changed after the fill target was checked. Take a new " +
  "snapshot and try again.";

/**
 * A refused fill. The message is a fixed text per reason, the reason code,
 * and agent-supplied names only (the secret's name or ID, an element uid),
 * so it holds no secret material and no page URL.
 */
export class FillDeniedError extends Error {
  constructor(
    readonly reason: FillDenyReason,
    ref: Pick<SecretRef, "secretId" | "name">,
    elementUid?: string,
  ) {
    const text =
      reason === "destination_changed"
        ? DESTINATION_CHANGED
        : DENY_REASON_MESSAGES[reason];
    super(
      `Refusing to fill "${ref.name ?? ref.secretId}": ${text} ` +
        `(${reason}${elementUid !== undefined ? `, element ${elementUid}` : ""})`,
    );
    this.name = "FillDeniedError";
  }
}

/** A fill that passed `authorize` against the live page. */
export type ValidatedFill = {
  ref: SecretRef;
  specs: FillFieldSpec[];
  request: FillRequest;
  decision: AuthorizationAllowed;
  /** The live top-level URL the decision was made on. */
  pageUrl: string;
};

function toRequest(specs: FillFieldSpec[]): FillRequest {
  return {
    targets: specs.map((s) =>
      s.key === undefined
        ? { elementId: s.elementUid }
        : { elementId: s.elementUid, key: s.key },
    ),
  };
}

function deny(
  ref: SecretRef,
  specs: FillFieldSpec[],
  reason: FillDenyReason,
  targetIndex?: number,
): FillDeniedError {
  const uid = targetIndex === undefined ? undefined : specs[targetIndex];
  return new FillDeniedError(reason, ref, uid?.elementUid);
}

/**
 * Authorize every requested element on the live page. Request-shape and
 * binding checks run first, before the browser is touched. Plain fills
 * check `sbm:selector`; keyed fills check the key's selector from
 * `sbm:fields` (and keys the binding doesn't declare are refused — the
 * agent cannot invent new destinations for payload parts).
 */
export async function validateTargets(
  ctx: ToolContext,
  ref: SecretRef,
  specs: FillFieldSpec[],
): Promise<ValidatedFill> {
  const request = toRequest(specs);
  const early = validateRequest(ref, request);
  if (!early.allowed) throw deny(ref, specs, early.reason, early.targetIndex);
  // A uid this session never handed out (or one a navigation or restart
  // invalidated) is refused before the page is looked at, so the agent is
  // told to take a new snapshot rather than about the page it is on.
  const unknown = specs.findIndex((s) => !ctx.session.hasElement(s.elementUid));
  if (unknown !== -1) throw deny(ref, specs, "target_not_observed", unknown);

  const observation = await observeTargets(ctx.session, ref, request);
  const decision = authorize(ref, request, observation);
  if (!decision.allowed) {
    throw deny(ref, specs, decision.reason, decision.targetIndex);
  }
  return {
    ref,
    specs,
    request,
    decision,
    pageUrl: observation.topLevelUrl,
  };
}

/**
 * Throws unless `later` was made on the same destination as `earlier`:
 * the same browser, tab, documents and elements.
 */
export function assertSameDestination(
  earlier: ValidatedFill,
  later: ValidatedFill,
): void {
  if (!isSameDestination(earlier.decision, later.decision)) {
    throw deny(later.ref, later.specs, "destination_changed");
  }
}

/**
 * Authorize target `index` again on a fresh observation, immediately before
 * its write, and require the destination that was checked. Only that target
 * is observed: an earlier write may have made the page replace an element
 * it is done with. Returns the target's redaction identity.
 */
async function recheckTarget(
  ctx: ToolContext,
  fill: ValidatedFill,
  index: number,
): Promise<RedactionTarget> {
  const request = { targets: [fill.request.targets[index]!] };
  const observation = await observeTargets(ctx.session, fill.ref, request);
  const current = authorize(fill.ref, request, observation);
  if (!current.allowed) throw deny(fill.ref, fill.specs, current.reason, index);
  const checked: AuthorizationAllowed = {
    ...fill.decision,
    targets: [fill.decision.targets[index]!],
  };
  if (!isSameDestination(checked, current)) {
    throw deny(fill.ref, fill.specs, "destination_changed", index);
  }
  const target = current.targets[0]!;
  return {
    browserSessionId: current.browserSessionId,
    tabId: current.tabId,
    frameId: target.frameId,
    documentId: target.documentId,
    elementId: target.elementId,
  };
}

/**
 * Route exported plaintext into the validated targets. For keyed fills the
 * value must be a JSON object holding every requested key. The value (and,
 * for a secret bound with sbm:fields, each payload part) is registered with
 * the redaction registry before anything touches the page. Each target is
 * authorized again immediately before its write, and registered as a
 * redaction target before the write.
 *
 * Parts shorter than the registry's minimum length (a 3-digit CVC) are not
 * text-scanned; the registered target still redacts the field itself.
 *
 * Returns what each field holds after its write, in `fill.specs` order.
 */
export async function injectResolved(
  ctx: ToolContext,
  exported: ExportedSecret,
  fill: ValidatedFill,
): Promise<FieldCheck[]> {
  const checks: FieldCheck[] = [];
  try {
    ctx.registry.registerValues(redactionEntries(exported.ref, exported.value));
    let payload: Record<string, unknown> | undefined;
    if (fill.specs.some((s) => s.key !== undefined)) {
      try {
        payload = JSON.parse(exported.value) as Record<string, unknown>;
      } catch {
        throw new Error(
          "Secret value is not valid JSON; keyed fills need a JSON-object secret",
        );
      }
    }
    for (const [index, spec] of fill.specs.entries()) {
      let value = exported.value;
      if (spec.key !== undefined) {
        const part = payload?.[spec.key];
        if (typeof part !== "string") {
          throw new Error(`Secret payload has no string field "${spec.key}"`);
        }
        value = part;
      }
      const target = await recheckTarget(ctx, fill, index);
      ctx.registry.registerTarget(target, exported.ref.secretId);
      checks.push(
        await injectSecret(ctx.session, spec.elementUid, {
          ref: exported.ref,
          value,
          release: () => {},
        }),
      );
    }
    return checks;
  } finally {
    exported.release();
  }
}

/**
 * The result of a completed fill: the outcome and, for each field, the
 * non-secret facts read back after the write. `confirmed` is true when
 * every field holds its value.
 */
export function filledResult(
  secretId: string,
  specs: FillFieldSpec[],
  checks: FieldCheck[],
) {
  return {
    filled: true,
    confirmed: checks.every((c) => c.matches),
    secret_id: secretId,
    element_uids: specs.map((s) => s.elementUid),
    fields: specs.map((s, i) => ({
      element_uid: s.elementUid,
      ...(s.key !== undefined ? { key: s.key } : {}),
      ...checks[i]!,
    })),
  };
}
