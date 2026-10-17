import { expect, test } from "bun:test";

import { InFlightIds } from "../src/inflight.js";

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
const cancel = (requestId: string | number) => ({
  jsonrpc: "2.0" as const,
  method: "notifications/cancelled",
  params: { requestId },
});
const free = (ids: InFlightIds, id: string | number) => {
  const r = ids.reserve(call(id));
  if (r.ok) r.done();
  return r.ok;
};

test("refuses an id in flight, and one id twice in a batch", () => {
  const ids = new InFlightIds();
  // Only requests count: not notifications, responses, or a null id.
  const r = ids.reserve([
    call(1),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    answer(2),
    { jsonrpc: "2.0", id: null, method: "ping" },
  ]);
  expect(r.ok).toBe(true);
  expect(ids.reserve(call(1))).toEqual({ ok: false, id: 1 });
  expect(free(ids, 2)).toBe(true);
  // A batch with one clashing id is refused whole.
  expect(ids.reserve([call(3), call(1)])).toEqual({ ok: false, id: 1 });
  expect(free(ids, 3)).toBe(true);
  expect(ids.reserve([call(4), call(4)])).toEqual({ ok: false, id: 4 });
  // 1 and "1" are different ids, as they are to the transport.
  expect(free(ids, "1")).toBe(true);
});

test("an id is free once the server has answered or cancelled it, or never saw it", () => {
  // Answered or cancelled after dispatch: free at once, whether or not the
  // HTTP response has ended.
  for (const settle of [
    (ids: InFlightIds) => ids.outbound(answer(1)),
    (ids: InFlightIds) => ids.inbound(cancel(1)),
  ]) {
    const ids = new InFlightIds();
    const r = ids.reserve(call(1));
    if (!r.ok) throw new Error("reserve failed");
    ids.inbound(call(1));
    expect(free(ids, 1)).toBe(false);
    settle(ids);
    expect(free(ids, 1)).toBe(true);
  }

  // A cancel that arrives before its request does nothing to the server,
  // which still answers.
  const early = new InFlightIds();
  if (!early.reserve(call(1)).ok) throw new Error("reserve failed");
  early.inbound(cancel(1));
  early.inbound(call(1));
  expect(free(early, 1)).toBe(false);
  early.outbound(answer(1));
  expect(free(early, 1)).toBe(true);

  // The transport refused the POST: the server never saw the id.
  const refused = new InFlightIds();
  const r = refused.reserve(call(1));
  if (!r.ok) throw new Error("reserve failed");
  expect(free(refused, 1)).toBe(false);
  r.done();
  r.done();
  expect(free(refused, 1)).toBe(true);
});

test("after a disconnect, the id stays taken until the server answers", () => {
  const ids = new InFlightIds();
  const r = ids.reserve(call(1));
  if (!r.ok) throw new Error("reserve failed");
  ids.inbound(call(1));
  r.done();
  // A late answer must not go to a new request with this id.
  expect(free(ids, 1)).toBe(false);
  // A request the server sends to the client is not an answer.
  ids.outbound({ jsonrpc: "2.0", id: 1, method: "elicitation/create" });
  expect(free(ids, 1)).toBe(false);
  ids.outbound(answer(1));
  expect(free(ids, 1)).toBe(true);
});
