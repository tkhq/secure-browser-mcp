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

test("an id is free once its response ends and the server is done", () => {
  const cases: [string, (ids: InFlightIds) => void][] = [
    ["answered", (ids) => ids.outbound(answer(1))],
    [
      "cancelled",
      (ids) =>
        ids.inbound({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        }),
    ],
  ];
  for (const [, settle] of cases) {
    const ids = new InFlightIds();
    const r = ids.reserve(call(1));
    if (!r.ok) throw new Error("reserve failed");
    ids.inbound(call(1));
    settle(ids);
    expect(free(ids, 1)).toBe(false);
    r.done();
    expect(free(ids, 1)).toBe(true);
  }

  // The transport refused the POST: the server never saw the id.
  const ids = new InFlightIds();
  const r = ids.reserve(call(1));
  if (!r.ok) throw new Error("reserve failed");
  r.done();
  r.done();
  expect(free(ids, 1)).toBe(true);
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
