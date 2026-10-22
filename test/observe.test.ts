import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  authorize,
  createSecretRef,
  type FillRequest,
  type SecretRef,
} from "@turnkey/browser-secrets";
import fixtureFile from "@turnkey/browser-secrets/fixtures/conformance.json" with { type: "json" };
import type { ElementHandle, Frame, Page } from "puppeteer-core";

import { LocalChromeHost } from "../src/browser/hosts.js";
import {
  frameDocument,
  observeTargets,
  topLevelDocument,
} from "../src/browser/observe.js";
import { BrowserSession } from "../src/browser/session.js";
import { findChrome } from "../src/runtime.js";
import { OTHER, PROVIDER, startFrameFixture } from "./fixtures/frames.js";
import { FIXTURE_ORIGIN, startFixtureServer } from "./fixtures/serve.js";

/**
 * The observation builder against a real browser and the fixture pages.
 * `authorize` trusts the observation, so these tests check that each fact
 * comes from the live page and that page script cannot change it.
 */

let fixture: { stop: () => void };
let frameFixture: { stop: () => void };
let session: BrowserSession;
let page: Page;

beforeAll(async () => {
  fixture = startFixtureServer();
  frameFixture = startFrameFixture();
  session = new BrowserSession(
    new LocalChromeHost({ executablePath: findChrome(), headless: true }),
  );
  page = await session.ensureStarted();
});

afterAll(async () => {
  await session.close();
  fixture.stop();
  frameFixture.stop();
});

/** Registers elements with the session the way a snapshot does. */
async function register(
  handles: Record<string, ElementHandle<Element>>,
): Promise<void> {
  session.setElements(
    await Promise.all(
      Object.entries(handles).map(async ([uid, handle]) => {
        const doc = await frameDocument(session, handle.frame);
        if (!doc) throw new Error(`cannot place the frame of ${uid}`);
        return {
          uid,
          backendNodeId: await handle.backendNodeId(),
          handle,
          cdp: doc.cdp,
          frameId: doc.document.frameId,
          documentId: doc.document.documentId,
        };
      }),
    ),
  );
}

async function byName(name: string): Promise<ElementHandle<Element>> {
  const handle = await page.$(`[name=${name}]`);
  if (!handle) throw new Error(`fixture has no element named ${name}`);
  return handle;
}

const passwordRef = createSecretRef({
  secretId: "s1",
  staticProperties: {
    "sbm:origin": FIXTURE_ORIGIN,
    "sbm:url-pattern": "/login*",
    "sbm:selector": "input[type=password]",
  },
});

describe("observeTargets", () => {
  test("reads frame, document and selector facts from the live page", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/login#top`);
    await register({
      pw: await byName("password"),
      user: await byName("username"),
    });
    const request = { targets: [{ elementId: "pw" }, { elementId: "user" }] };
    const observation = await observeTargets(session, passwordRef, request);
    const top = await topLevelDocument(session);

    expect(observation.browserSessionId).toBe(session.sessionId());
    expect(observation.topLevelUrl).toBe(`${FIXTURE_ORIGIN}/login#top`);
    expect(observation.targets).toEqual([
      {
        elementId: "pw",
        frames: [
          {
            frameId: top.document.frameId,
            documentId: top.document.documentId,
            url: `${FIXTURE_ORIGIN}/login#top`,
            origin: FIXTURE_ORIGIN,
          },
        ],
        shadowRoot: "none",
        selectorMatches: { "input[type=password]": true },
      },
      expect.objectContaining({
        elementId: "user",
        selectorMatches: { "input[type=password]": false },
      }),
    ]);
    expect(authorize(passwordRef, request, observation)).toMatchObject({
      allowed: false,
      reason: "selector_mismatch",
      targetIndex: 1,
    });
  });

  test("a new document gets a new document identity", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/login`);
    const first = await topLevelDocument(session);
    await page.goto(`${FIXTURE_ORIGIN}/login`);
    const second = await topLevelDocument(session);
    expect(second.document.frameId).toBe(first.document.frameId);
    expect(second.document.documentId).not.toBe(first.document.documentId);
  });

  test("page script cannot fake a selector match", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/login`);
    await page.evaluate(() => {
      Element.prototype.matches = () => true;
      Element.prototype.getRootNode = () => document;
    });
    await register({ user: await byName("username") });
    const observation = await observeTargets(session, passwordRef, {
      targets: [{ elementId: "user" }],
    });
    expect(observation.targets[0]?.selectorMatches).toEqual({
      "input[type=password]": false,
    });
  });

  test("a selector the browser rejects records false", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/login`);
    await register({ pw: await byName("password") });
    const ref = createSecretRef({
      secretId: "s2",
      staticProperties: {
        "sbm:origin": FIXTURE_ORIGIN,
        "sbm:selector": "input[",
      },
    });
    const observation = await observeTargets(session, ref, {
      targets: [{ elementId: "pw" }],
    });
    expect(observation.targets[0]?.selectorMatches).toEqual({
      "input[": false,
    });
  });

  test("reports open and closed shadow roots", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/login`);
    const [open, closed] = await Promise.all(
      (["open", "closed"] as const).map((mode) =>
        page.evaluateHandle((m) => {
          const host = document.createElement("div");
          document.body.append(host);
          const root = host.attachShadow({ mode: m });
          root.innerHTML = '<input type="password">';
          return root.querySelector("input")!;
        }, mode),
      ),
    );
    await register({
      open: open as ElementHandle<Element>,
      closed: closed as ElementHandle<Element>,
    });
    const request = {
      targets: [{ elementId: "open" }, { elementId: "closed" }],
    };
    const observation = await observeTargets(session, passwordRef, request);
    expect(observation.targets.map((t) => t.shadowRoot)).toEqual([
      "open",
      "closed",
    ]);
    expect(observation.targets[0]?.selectorMatches).toEqual({
      "input[type=password]": true,
    });
    expect(authorize(passwordRef, request, observation)).toMatchObject({
      allowed: false,
      reason: "unsupported_shadow_root",
      targetIndex: 1,
    });
  });

  test("leaves out detached and unknown elements", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/login`);
    const pw = await byName("password");
    await register({ pw });
    await pw.evaluate((el) => el.remove());
    const request = {
      targets: [{ elementId: "pw" }, { elementId: "never-snapshotted" }],
    };
    const observation = await observeTargets(session, passwordRef, request);
    expect(observation.targets).toEqual([]);
    expect(authorize(passwordRef, request, observation)).toMatchObject({
      allowed: false,
      reason: "target_not_observed",
    });
  });

  test("observes an element named under several keys once", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/checkout`);
    await register({ n: await byName("cardNumber") });
    const ref = createSecretRef({
      secretId: "card",
      staticProperties: {
        "sbm:origin": FIXTURE_ORIGIN,
        "sbm:fields": JSON.stringify({
          number: "input[name=cardNumber]",
          cvc: "input[name=cardCvc]",
        }),
      },
    });
    const observation = await observeTargets(session, ref, {
      targets: [
        { key: "number", elementId: "n" },
        { key: "cvc", elementId: "n" },
      ],
    });
    expect(observation.targets).toHaveLength(1);
    expect(observation.targets[0]?.selectorMatches).toEqual({
      "input[name=cardNumber]": true,
      "input[name=cardCvc]": false,
    });
  });
});

/**
 * The browser-secrets conformance fixture, run against observations this
 * builder makes from the live fixture pages. The fixture's own
 * observations are hand-written; here only the secret, the request and the
 * expected decision come from the fixture. A fixture element ID names the
 * fixture field with that `name`.
 *
 * The iframe cases run against the frame fixture (test/fixtures/frames.ts),
 * which serves the port 5001 and 5002 pages the fixture names. Cases on
 * other origins (shop.example) need pages this repo does not serve, and the
 * rest need observations a live page cannot produce. They are listed so a
 * new case is not skipped silently.
 */
describe("conformance fixture against live observations", () => {
  type Case = {
    kind: string;
    name: string;
    secret: { secretId: string; staticProperties: Record<string, string> };
    request: FillRequest;
    observation: { topLevelUrl: string };
    expect: { allowed: boolean; reason?: string };
  };
  const cases = (fixtureFile as unknown as { cases: Case[] }).cases.filter(
    (c) => c.kind === "authorize",
  );

  const LIVE = [
    "fills every card part with one request",
    "refuses a request with no targets",
    "refuses a mix of keyed and unkeyed targets",
    "refuses a secret without a binding",
    "refuses an unkeyed fill of a field-bound card",
    "refuses a payload key the binding does not declare",
    "refuses a page outside the bound URL pattern",
    "refuses an element that does not match the bound selector",
    "allows nested frames whose every ancestor is bound",
    "refuses a srcdoc frame",
    "refuses a sandboxed frame with an opaque origin",
    "refuses a same-origin iframe without sbm:frame-origin",
    "refuses a frame whose origin is not the bound frame origin",
    "refuses nested frames with an unbound intermediate origin",
    "refuses a frame-bound secret in the top-level document",
  ];
  const NOT_LIVE = [
    "refuses a request with an empty element ID",
    "refuses the same key and element twice",
    "refuses a secret with a malformed binding",
    "refuses a malformed observation",
    "refuses a look-alike host for an origin-only secret",
    "refuses a detached target",
    "refuses a frame ancestry that does not start at the top-level URL",
    "refuses an element in a closed shadow root",
    "refuses a target without selector evidence",
  ];

  test("every authorize case is either run live or listed as not live", () => {
    expect(cases.map((c) => c.name).sort()).toEqual(
      [...LIVE, ...NOT_LIVE].sort(),
    );
  });

  /** Fixture element IDs that are not field names on the fixture pages. */
  const ALIASES: Record<string, string> = {
    // The URL-pattern case targets a password field on /checkout, which
    // has none; any field shows the URL check, which runs first.
    password: "cardName",
  };

  /** The frame fixture has two fields named "nested": pick the one whose
   * frame sits inside this wrapper. */
  const WRAPPERS: Record<string, string> = {
    "allows nested frames whose every ancestor is bound": `${PROVIDER}/wrapper`,
    "refuses nested frames with an unbound intermediate origin": `${OTHER}/wrapper`,
  };

  /** The field named `name` in any frame of the page. */
  async function inFrames(
    name: string,
    wrapper: string | undefined,
  ): Promise<ElementHandle<Element> | null> {
    const within = (frame: Frame) =>
      wrapper === undefined || frame.parentFrame()?.url() === wrapper;
    for (const frame of page.frames().filter(within)) {
      const handle = await frame.$(`pierce/[name=${name}]`);
      if (handle) return handle;
    }
    return null;
  }

  for (const c of cases.filter((c) => LIVE.includes(c.name))) {
    test(c.name, async () => {
      await page.goto(c.observation.topLevelUrl);
      const handles: Record<string, ElementHandle<Element>> = {};
      for (const { elementId } of c.request.targets) {
        const handle =
          (await inFrames(elementId, WRAPPERS[c.name])) ??
          (ALIASES[elementId] ? await byName(ALIASES[elementId]) : null);
        if (handle) handles[elementId] = handle;
      }
      await register(handles);
      const ref: SecretRef = createSecretRef(c.secret);
      const observation = await observeTargets(session, ref, c.request);
      const decision = authorize(ref, c.request, observation);
      const outcome = (allowed: boolean, reason?: string): string =>
        allowed ? "allowed" : `denied:${reason}`;
      expect(
        outcome(decision.allowed, decision.allowed ? "" : decision.reason),
      ).toBe(outcome(c.expect.allowed, c.expect.reason));
    });
  }
});
