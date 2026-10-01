import { afterAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FilePendingFillStore,
  MemoryPendingFillStore,
  scopedFills,
  tenantStateKey,
  type PendingFill,
} from "../src/broker/pending-store.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "sbm-store-"));
  dirs.push(d);
  return d;
};
afterAll(() =>
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true })),
);

const fill = (fillId: string): PendingFill => ({
  fillId,
  pending: {
    ref: { secretId: "s1", name: "n", staticProperties: {} },
    activityId: "act",
    fingerprint: "fp",
    material: "{}",
  },
  targets: [{ elementUid: "e1" }],
  pageUrl: "https://example.com/",
  createdAt: Date.now(),
});

test("an orphaned fill can be claimed only by the same principal", async () => {
  const store = new MemoryPendingFillStore();
  const gone = () => false;
  const alice1 = scopedFills(store, { owner: "s1", principal: "alice" });
  await alice1.put(fill("f1"));

  const bob = scopedFills(store, {
    owner: "s2",
    principal: "bob",
    isLive: gone,
  });
  expect(await bob.get("f1")).toBeUndefined();
  await bob.delete("f1");

  const alice2 = scopedFills(store, {
    owner: "s3",
    principal: "alice",
    isLive: gone,
  });
  expect((await alice2.get("f1"))?.fillId).toBe("f1");
  expect(alice2.list().map((f) => f.fillId)).toEqual(["f1"]);
  expect(alice1.list()).toEqual([]);
});

test("tenant keys are independent, so one tenant's files do not load under another's key", async () => {
  const master = randomBytes(32);
  const keyA = tenantStateKey(master, "a");
  const keyB = tenantStateKey(master, "b");
  expect(keyA.equals(keyB)).toBe(false);
  expect(keyA.equals(tenantStateKey(master, "a"))).toBe(true);

  const dirA = tempDir();
  const a = new FilePendingFillStore(dirA, keyA);
  await scopedFills(a, { owner: "s1", principal: "p" }).put(fill("f1"));
  expect(readdirSync(dirA).length).toBe(1);

  // Copying A's file into B's directory gives B nothing.
  const dirB = tempDir();
  cpSync(dirA, dirB, { recursive: true });
  const b = new FilePendingFillStore(dirB, keyB);
  const bView = scopedFills(b, {
    owner: "s2",
    principal: "p",
    isLive: () => false,
  });
  expect(await bView.get("f1")).toBeUndefined();

  const reloaded = new FilePendingFillStore(dirA, keyA);
  const aView = scopedFills(reloaded, {
    owner: "s3",
    principal: "p",
    isLive: () => false,
  });
  expect((await aView.get("f1"))?.fillId).toBe("f1");
});
