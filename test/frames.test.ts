import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";

import { RedactionRegistry } from "@turnkey/browser-secrets";
import type { Frame } from "puppeteer-core";

import { MockSecretsClient } from "../src/broker/mock-secrets.js";
import {
  MemoryPendingFillStore,
  scopedFills,
} from "../src/broker/pending-store.js";
import { LocalChromeHost } from "../src/browser/hosts.js";
import { BrowserSession } from "../src/browser/session.js";
import type { PageSnapshot, SnapshotElement } from "../src/browser/snapshot.js";
import { BrowserHandles, browserScope } from "../src/browsers.js";
import { findChrome } from "../src/runtime.js";
import { awaitFill } from "../src/tools/await-fill.js";
import { click } from "../src/tools/click.js";
import { fillSecret } from "../src/tools/fill-secret.js";
import { navigate } from "../src/tools/navigate.js";
import { snapshot as snapshotTool } from "../src/tools/snapshot.js";
import type { AnyToolDef, ToolContext } from "../src/tools/tool.js";
import { typeText } from "../src/tools/type-text.js";
import {
  MERCHANT,
  OTHER,
  PROVIDER,
  startFrameFixture,
} from "./fixtures/frames.js";

/**
 * Fills into iframes and open shadow roots (EMG-66), against a real browser
 * and the frame fixture. Tools run as server.ts runs them: every result
 * passes through the registry's scrub, and every error message through
 * scrubText. The transcript of those outputs must never hold a plaintext.
 */

const SECRET = "frame-canary-must-never-reach-agent";
const CARD = { number: "4242424242424242", expiry: "1234", cvc: "123" };
const REDACTED = "[REDACTED:secret-filled-field]";

let fixture: { stop: () => void };
let ctx: ToolContext;
let transcript = "";
let exports = 0;
let beforeExport: (() => Promise<void>) | undefined;
let duringApproval: (() => Promise<void>) | undefined;

/** Secret IDs, by the seed order below. */
const ID = {
  main: "mock-secret-1",
  same: "mock-secret-2",
  other: "mock-secret-3",
  cross: "mock-secret-4",
  pending: "mock-secret-5",
  card: "mock-secret-6",
};

beforeAll(async () => {
  fixture = startFrameFixture();
  const seed = (name: string, frameOrigin?: string) => ({
    name,
    value: SECRET,
    staticProperties: {
      "sbm:origin": MERCHANT,
      "sbm:url-pattern": "/checkout*",
      "sbm:selector": "input",
      ...(frameOrigin ? { "sbm:frame-origin": frameOrigin } : {}),
    },
  });
  const secrets = new MockSecretsClient(
    [
      // No frame binding: main frame only, open shadow roots included.
      seed("main"),
      seed("same", MERCHANT),
      seed("other", OTHER),
      seed("cross", PROVIDER),
      seed("pending", PROVIDER),
      {
        name: "card",
        value: JSON.stringify(CARD),
        staticProperties: {
          "sbm:origin": MERCHANT,
          "sbm:url-pattern": "/pay",
          "sbm:frame-origin": PROVIDER,
          "sbm:fields": JSON.stringify({
            number: "input[name=number]",
            expiry: "input[name=expiry]",
            cvc: "input[name=cvc]",
          }),
        },
      },
    ],
    { consensusNames: ["pending"], approvalDelayMs: 60_000 },
  );
  const exportSecret = secrets.exportSecret.bind(secrets);
  secrets.exportSecret = async (ref) => {
    exports++;
    await beforeExport?.();
    return exportSecret(ref);
  };
  // Approval arrives as soon as the test's hook (if any) has run.
  const awaitExport = secrets.awaitExport.bind(secrets);
  secrets.awaitExport = async (pending) => {
    await duringApproval?.();
    return awaitExport(
      { ...pending, material: JSON.stringify({ approvedAt: 0 }) },
      1_000,
    );
  };
  ctx = {
    backend: "mock",
    secrets,
    browsers: browserScope({
      handles: new BrowserHandles(
        { max: 1, perEndpoint: 1, perPrincipal: () => 1 },
        60_000,
      ),
      owner: { endpoint: "test", principal: "test", client: undefined },
      make: () => {
        throw new Error("unused");
      },
    }),
    session: new BrowserSession(
      new LocalChromeHost({ executablePath: findChrome(), headless: true }),
    ),
    registry: new RedactionRegistry(),
    pendingFills: scopedFills(new MemoryPendingFillStore(), {
      owner: "test",
      principal: "test",
    }),
  };
});

beforeEach(async () => {
  beforeExport = undefined;
  duringApproval = undefined;
  await call(navigate, { url: `${MERCHANT}/checkout` });
});

afterAll(async () => {
  await ctx?.session.close();
  fixture?.stop();
});

type Outcome = { error: boolean; text: string; body: unknown };

/** Runs a tool the way server.ts does, and records what the agent sees. */
async function call(tool: AnyToolDef, args: object = {}): Promise<Outcome> {
  let outcome: Outcome;
  try {
    const body = ctx.registry.scrub(await tool.handler(ctx, args as never));
    outcome = { error: false, text: JSON.stringify(body), body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const text = ctx.registry.scrubText(message);
    outcome = { error: true, text, body: undefined };
  }
  transcript += outcome.text;
  expect(outcome.text).not.toContain(SECRET);
  expect(outcome.text).not.toContain(CARD.number);
  return outcome;
}

async function snapshot(): Promise<PageSnapshot> {
  const result = await call(snapshotTool);
  expect(result.error, result.text).toBe(false);
  return result.body as PageSnapshot;
}

/** The element named `name`; with `parentUrl`, the one whose frame's parent
 * frame shows that URL. */
async function field(
  name: string,
  parentUrl?: string,
): Promise<SnapshotElement> {
  const found = (await snapshot()).elements.filter(
    (e) =>
      e.name === name &&
      (parentUrl === undefined ||
        ctx.session.resolveElement(e.uid).handle.frame.parentFrame()?.url() ===
          parentUrl),
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Reads a field's live value in the test process; the agent never can. */
async function liveValue(uid: string): Promise<string> {
  return ctx.session
    .resolveElement(uid)
    .handle.evaluate((el) => (el as HTMLInputElement).value);
}

function fill(secretId: string, element: SnapshotElement) {
  return call(fillSecret, { secret_id: secretId, element_uid: element.uid });
}

/** Points iframe `#id` of the top-level page at `url` and waits for it. */
async function navigateFrame(id: string, url: string): Promise<void> {
  const page = ctx.session.currentPage()!;
  const owner = (await page.$(`#${id}`))!;
  const frame = (await owner.contentFrame()) as Frame;
  const loaded = frame.waitForNavigation({ waitUntil: "load" });
  await owner.evaluate((el, src) => {
    (el as HTMLIFrameElement).src = src;
  }, url);
  await loaded;
  await owner.dispose();
}

test("snapshots list fields in frames and open shadow roots", async () => {
  const first = await snapshot();
  const names = first.elements.map((e) => e.name);
  for (const name of [
    "main",
    "shadow",
    "same",
    "other",
    "cross",
    "sandbox",
    "srcdoc",
  ]) {
    expect(names).toContain(name);
  }
  expect(names.filter((n) => n === "nested")).toHaveLength(2);
  expect(names).not.toContain("closed");

  // Frame elements say which origin they are in; top-level ones do not.
  const byName = (name: string) => first.elements.find((e) => e.name === name)!;
  expect(byName("main").frame_origin).toBeUndefined();
  expect(byName("shadow").frame_origin).toBeUndefined();
  expect(byName("same").frame_origin).toBe(MERCHANT);
  expect(byName("other").frame_origin).toBe(OTHER);
  expect(byName("cross").frame_origin).toBe(PROVIDER);
  expect(byName("sandbox").frame_origin).toBe("null");

  // Uids are unique across targets and stable across snapshots.
  const uids = first.elements.map((e) => e.uid);
  expect(new Set(uids).size).toBe(uids.length);
  expect((await snapshot()).elements.map((e) => e.uid)).toEqual(uids);

  // The provider frame is a real out-of-process target with its own
  // session; the same-site cross-origin frame shares the tab's.
  const target = (name: string) =>
    ctx.session.resolveElement(byName(name).uid).cdp;
  expect(target("cross")).not.toBe(target("main"));
  expect(target("other")).toBe(target("main"));
});

for (const [name, secretId] of [
  ["main", ID.main],
  ["shadow", ID.main],
  ["same", ID.same],
  ["other", ID.other],
  ["cross", ID.cross],
] as const) {
  test(`fills and redacts the ${name} field`, async () => {
    const target = await field(name);
    const result = await fill(secretId, target);
    expect(result.error, result.text).toBe(false);
    expect(result.body).toMatchObject({ filled: true });
    expect(await liveValue(target.uid)).toBe(SECRET);
    const after = (await snapshot()).elements.find((e) => e.uid === target.uid);
    expect(after?.value).toBe(REDACTED);
  });
}

test("fills a nested provider frame whose every ancestor is bound", async () => {
  const target = await field("nested", `${PROVIDER}/wrapper`);
  const result = await fill(ID.cross, target);
  expect(result.error, result.text).toBe(false);
  expect(await liveValue(target.uid)).toBe(SECRET);
});

test("one export fills a card split over three provider frames", async () => {
  await call(navigate, { url: `${MERCHANT}/pay` });
  const snap = await snapshot();
  const uid = (name: string) => snap.elements.find((e) => e.name === name)!.uid;
  const count = exports;
  const result = await call(fillSecret, {
    secret_id: ID.card,
    fields: [
      { key: "number", element_uid: uid("number") },
      { key: "expiry", element_uid: uid("expiry") },
      { key: "cvc", element_uid: uid("cvc") },
    ],
  });
  expect(result.error, result.text).toBe(false);
  expect(exports).toBe(count + 1);
  for (const [key, value] of Object.entries(CARD)) {
    expect(await liveValue(uid(key))).toBe(value);
  }
  const after = await snapshot();
  for (const key of Object.keys(CARD)) {
    expect(after.elements.find((e) => e.uid === uid(key))?.value).toBe(
      REDACTED,
    );
  }
  expect(transcript).not.toContain(CARD.number);
});

test("refuses frame mismatches before export, without filling", async () => {
  for (const [name, secretId, reason, parentUrl] of [
    // A secret without a frame binding stays in the main frame.
    ["same", ID.main, "frame_binding_required"],
    ["cross", ID.main, "frame_binding_required"],
    // The wrong frame origin on the approved site.
    ["other", ID.cross, "frame_origin_mismatch"],
    ["cross", ID.same, "frame_origin_mismatch"],
    // A frame-bound secret never fills the top-level document.
    ["main", ID.cross, "frame_bound_top_level_target"],
    ["shadow", ID.cross, "frame_bound_top_level_target"],
    ["sandbox", ID.cross, "opaque_origin"],
    ["srcdoc", ID.same, "unsupported_document_scheme"],
    ["nested", ID.cross, "unbound_intermediate_frame", `${OTHER}/wrapper`],
  ] as const) {
    const target = await field(name, parentUrl);
    const count = exports;
    const result = await fill(secretId, target);
    expect(result.error).toBe(true);
    expect(result.text).toContain(reason);
    expect(exports).toBe(count);
    expect(await liveValue(target.uid)).toBe("");
  }
});

test("refuses the provider frame on an unapproved top-level site", async () => {
  await call(navigate, { url: `${OTHER}/checkout` });
  const target = await field("cross");
  const count = exports;
  const result = await fill(ID.cross, target);
  expect(result.error).toBe(true);
  expect(result.text).toContain("top_level_origin_mismatch");
  expect(exports).toBe(count);
  expect(await liveValue(target.uid)).toBe("");
});

test("refuses a frame that navigates between export and write", async () => {
  const target = await field("cross");
  beforeExport = () => navigateFrame("cross", `${OTHER}/field?name=cross`);
  const result = await fill(ID.cross, target);
  expect(result.error).toBe(true);
  expect((await field("cross")).value).toBe("");
});

test("refuses a frame that navigates while approval is pending", async () => {
  const target = await field("cross");
  const pending = await fill(ID.pending, target);
  expect(pending.body).toMatchObject({ status: "pending_approval" });
  const { fill_id } = pending.body as { fill_id: string };

  // The provider frame moves to another origin during the wait. Approval
  // arrives, the re-check fails, and the plaintext is dropped.
  duringApproval = () => navigateFrame("cross", `${OTHER}/field?name=cross`);
  const failed = await call(awaitFill, { fill_id, timeout_seconds: 5 });
  expect(failed.error).toBe(true);
  expect(failed.text).toContain("no longer available");
  const moved = await field("cross");
  expect(moved.frame_origin).toBe(OTHER);
  expect(moved.value).toBe("");

  // The fill stays parked: back on the provider, a fresh uid completes it.
  duringApproval = undefined;
  await navigateFrame("cross", `${PROVIDER}/field?name=cross`);
  const fresh = await field("cross");
  expect(fresh.uid).not.toBe(target.uid);
  const done = await call(awaitFill, {
    fill_id,
    element_uid: fresh.uid,
    timeout_seconds: 5,
  });
  expect(done.error, done.text).toBe(false);
  expect(await liveValue(fresh.uid)).toBe(SECRET);
});

test("a removed iframe invalidates its uids", async () => {
  const target = await field("cross");
  await ctx.session.currentPage()!.$eval("#cross", (el) => el.remove());
  const count = exports;
  const result = await fill(ID.cross, target);
  expect(result.error).toBe(true);
  expect(result.text).toContain("target_not_observed");
  expect(exports).toBe(count);
});

test("a sibling frame's navigation keeps a filled field redacted", async () => {
  const target = await field("cross");
  expect((await fill(ID.cross, target)).error).toBe(false);
  await navigateFrame("same", `${MERCHANT}/field?name=same`);
  expect((await field("cross")).value).toBe(REDACTED);
});

test("type_text and click work in an out-of-process frame", async () => {
  const target = await field("cross");
  const typed = await call(typeText, {
    element_uid: target.uid,
    text: "public text",
  });
  expect(typed.error, typed.text).toBe(false);
  const snap = await snapshot();
  expect(snap.elements.find((e) => e.uid === target.uid)?.value).toBe(
    "public text",
  );
  const frameOf = (uid: string) => ctx.session.resolveElement(uid).cdp;
  const button = snap.elements.find(
    (e) => e.name === "button" && frameOf(e.uid) === frameOf(target.uid),
  )!;
  expect((await call(click, { element_uid: button.uid })).error).toBe(false);
  const clicked = (await snapshot()).elements.find((e) => e.uid === button.uid);
  expect(clicked?.text).toBe("clicked");
});

test("no tool output held a plaintext", () => {
  expect(transcript.length).toBeGreaterThan(0);
  expect(transcript).not.toContain(SECRET);
  expect(transcript).not.toContain(CARD.number);
});
