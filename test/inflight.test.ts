import { expect, test } from "bun:test";

import { InFlightIds, requestIds } from "../src/inflight.js";

/** src/inflight.ts: when a session's request ids are free again. */

const call = (id: string | number) => ({
  jsonrpc: "2.0" as const,
  id,
  method: "tools/call",
  params: { name: "snapshot" },
});
const answer = (id: string | number) => ({
  jsonrpc: "2.0" as const,
  id,
  result: {},
});

test("only requests have ids that count", () => {
  expect(
    requestIds([
      call(1),
      call("a"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      answer(2),
      { jsonrpc: "2.0", id: null, method: "ping" },
      "junk",
      null,
    ]),
  ).toEqual([1, "a"]);
  expect(requestIds(undefined)).toEqual([]);
});

test("refuses an id in flight, and one id twice in a batch", () => {
  const ids = new InFlightIds();
  expect(ids.reserve(call(1)).ok).toBe(true);
  expect(ids.reserve(call(1))).toEqual({ ok: false, id: 1 });
  // A batch with one clashing id is refused whole.
  expect(ids.reserve([call(2), call(1)])).toEqual({ ok: false, id: 1 });
  expect(ids.has(2)).toBe(false);
  expect(ids.reserve([call(3), call(3)])).toEqual({ ok: false, id: 3 });
  // 1 and "1" are different ids, as they are to the transport.
  expect(ids.reserve(call("1")).ok).toBe(true);
});

test("an answered id is free once its HTTP response ends", () => {
  const ids = new InFlightIds();
  const r = ids.reserve(call(1));
  if (!r.ok) throw new Error("reserve failed");
  ids.inbound(call(1));
  ids.outbound(answer(1));
  expect(ids.has(1)).toBe(true);
  r.done();
  expect(ids.has(1)).toBe(false);
});

test("after a disconnect, the id stays taken until the server answers", () => {
  const ids = new InFlightIds();
  const r = ids.reserve(call(1));
  if (!r.ok) throw new Error("reserve failed");
  ids.inbound(call(1));
  r.done();
  // The server still holds the request; a late answer must not go to a
  // new request with this id.
  expect(ids.reserve(call(1)).ok).toBe(false);
  // A request the server sends to the client does not count as an answer.
  ids.outbound({ jsonrpc: "2.0", id: 1, method: "elicitation/create" });
  expect(ids.has(1)).toBe(true);
  ids.outbound(answer(1));
  expect(ids.has(1)).toBe(false);
});

test("a cancelled id is free once its HTTP response ends", () => {
  const ids = new InFlightIds();
  const r = ids.reserve(call(1));
  if (!r.ok) throw new Error("reserve failed");
  ids.inbound(call(1));
  ids.inbound({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 1 },
  });
  r.done();
  expect(ids.has(1)).toBe(false);
});

test("a request the transport refused is free when its response ends", () => {
  const ids = new InFlightIds();
  const r = ids.reserve(call(1));
  if (!r.ok) throw new Error("reserve failed");
  r.done();
  r.done();
  expect(ids.has(1)).toBe(false);
});
