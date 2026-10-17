import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { watchGetStream } from "../src/get-stream.js";

/** src/get-stream.ts: when a GET stream is ended or released. */

/** A GET whose response the transport does not end, so only the 1 s
 * fallback after expiry closes it. */
function openGet(expiresAt: number | undefined) {
  const req = new EventEmitter();
  const res = {
    headersSent: true,
    statusCode: 200,
    writableFinished: false,
    destroy: () => req.emit("close"),
  };
  let closes = 0;
  const transport = { closeStandaloneSSEStream: () => void closes++ };
  watchGetStream(transport, req, res, expiresAt);
  return { req, closes: () => closes };
}

test("a dropped GET stream is released", () => {
  const get = openGet(undefined);
  get.req.emit("close");
  expect(get.closes()).toBe(1);
});

test("the fallback after an expiry does not release a newer stream", async () => {
  const get = openGet(Date.now());
  await Bun.sleep(50);
  // The expiry closed the session's stream; a new one may open now.
  expect(get.closes()).toBe(1);
  // The fallback destroys the old response, which fires its request's
  // `close` with the response unfinished.
  await Bun.sleep(1_100);
  expect(get.closes()).toBe(1);
});
