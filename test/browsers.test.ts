import { expect, test } from "bun:test";

import { RedactionRegistry } from "@turnkey/browser-secrets";

import {
  MemoryPendingFillStore,
  scopedFills,
} from "../src/broker/pending-store.js";
import type { BrowserHost } from "../src/browser/hosts.js";
import { BrowserSession } from "../src/browser/session.js";
import {
  BrowserHandles,
  browserScope,
  UnknownBrowserError,
  type BrowserContext,
  type HandleOwner,
} from "../src/browsers.js";

/** Browser handles without a browser: a host that counts stops. */
function harness(limits = { max: 10, perEndpoint: 10, perPrincipal: 10 }) {
  const stopped: string[] = [];
  const handles = new BrowserHandles(
    { ...limits, perPrincipal: () => limits.perPrincipal },
    1_000,
  );
  const make = (id: string): BrowserContext => {
    const host: BrowserHost = {
      kind: "local",
      start: () => Promise.reject(new Error("no browser in unit tests")),
      stop: async () => {
        stopped.push(id);
      },
    };
    return {
      session: new BrowserSession(host),
      registry: new RedactionRegistry(),
      pendingFills: scopedFills(new MemoryPendingFillStore(), {
        owner: id,
        principal: "p",
      }),
    };
  };
  return { handles, make, stopped };
}

const alice: HandleOwner = { endpoint: "t1", principal: "alice", client: "c" };

test("browser ids are random, not sequential", () => {
  const { handles, make } = harness({
    max: 100,
    perEndpoint: 100,
    perPrincipal: 100,
  });
  const ids = Array.from({ length: 50 }, () => handles.open(alice, make));
  expect(new Set(ids).size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^br_[A-Za-z0-9_-]{32}$/);
});

test("another owner gets the same error as an id that was never minted", async () => {
  const { handles, make } = harness();
  const id = handles.open(alice, make);
  const others: HandleOwner[] = [
    { ...alice, principal: "bob" },
    { ...alice, endpoint: "t2" },
    { ...alice, client: "other" },
    { ...alice, client: undefined },
  ];
  const message = async (owner: HandleOwner, browserId: string) =>
    handles
      .use(browserId, owner, async () => "ran")
      .catch((err: Error) => err.message);
  for (const owner of others) {
    expect(await message(owner, id)).toBe(new UnknownBrowserError(id).message);
    expect(await handles.close(id, owner)).toBe(false);
  }
  expect(await message(alice, id)).toBe("ran");
});

test("each cap refuses one more handle", () => {
  const { handles, make } = harness({
    max: 3,
    perEndpoint: 2,
    perPrincipal: 1,
  });
  handles.open(alice, make);
  expect(() => handles.open(alice, make)).toThrow("close_browser");
  handles.open({ ...alice, principal: "bob" }, make);
  expect(() => handles.open({ ...alice, principal: "carol" }, make)).toThrow(
    "tenant is at its browser limit",
  );
  handles.open({ ...alice, endpoint: "t2" }, make);
  expect(() => handles.open({ ...alice, endpoint: "t3" }, make)).toThrow(
    "Broker is at its browser limit",
  );
});

test("the sweep closes idle handles but not one in use", async () => {
  const { handles, make, stopped } = harness();
  const idle = handles.open(alice, make);
  const busy = handles.open(alice, make);
  let release!: () => void;
  const running = handles.use(
    busy,
    alice,
    () => new Promise<void>((r) => (release = r)),
  );

  await handles.sweep(Date.now() + 5_000);
  expect(handles.has(idle)).toBe(false);
  expect(stopped).toContain(idle);
  expect(handles.has(busy)).toBe(true);

  release();
  await running;
  // Its idle time starts when the call ends.
  await handles.sweep(Date.now() + 500);
  expect(handles.has(busy)).toBe(true);
  await handles.sweep(Date.now() + 5_000);
  expect(handles.has(busy)).toBe(false);
  expect(handles.size).toBe(0);
});

test("a closed handle frees its slot and closes its browser", async () => {
  const { handles, make, stopped } = harness({
    max: 1,
    perEndpoint: 1,
    perPrincipal: 1,
  });
  const id = handles.open(alice, make);
  expect(await handles.close(id, alice)).toBe(true);
  expect(stopped).toEqual([id]);
  expect(await handles.close(id, alice)).toBe(false);
  expect(handles.open(alice, make)).not.toBe(id);
});

test("a scope without its own browser requires a browser_id", async () => {
  const { handles, make } = harness();
  const scope = browserScope({ handles, owner: alice, make });
  await expect(scope.run(undefined, true, async () => "ran")).rejects.toThrow(
    "open_browser",
  );
  // A tool that touches no browser runs in an empty context.
  expect(
    await scope.run(undefined, false, async (b) => b.pendingFills.list()),
  ).toEqual([]);

  const id = scope.open();
  let seen: BrowserContext | undefined;
  await scope.run(id, true, async (b) => void (seen = b));
  expect(seen).toBeDefined();

  const implicit = make("implicit");
  const session = browserScope({ handles, owner: alice, make, implicit });
  await session.run(undefined, true, async (b) => expect(b).toBe(implicit));
  await session.run(id, true, async (b) => expect(b).toBe(seen!));
});
