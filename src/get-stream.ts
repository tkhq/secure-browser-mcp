/**
 * End a GET (SSE) stream when the token that opened it expires, and release
 * it when the client drops the connection. POSTs are checked one by one, but
 * a GET stream would outlive its token. The transport allows one GET stream
 * per session, so this is that stream, and until a dropped one is released
 * the session cannot open another. The transport releases it on the
 * response's `close`, which node:http on Bun 1.3.x and earlier does not
 * emit when the client disconnects; the request's `close` fires on every
 * runtime.
 */

/** The parts of the transport, request, and response this uses. */
type Transport = { closeStandaloneSSEStream(): void };
type StreamRequest = { once(event: "close", listener: () => void): unknown };
type StreamResponse = {
  readonly headersSent: boolean;
  readonly statusCode: number;
  readonly writableFinished: boolean;
  destroy(): unknown;
};

export function watchGetStream(
  transport: Transport,
  req: StreamRequest,
  res: StreamResponse,
  expiresAt: number | undefined,
): void {
  // After expiry the session's stream can already be a new one, which a
  // late `close` of this request must not release.
  let expired = false;
  const timer =
    expiresAt === undefined
      ? undefined
      : setTimeout(
          () => {
            expired = true;
            transport.closeStandaloneSSEStream();
            // If closing the stream does not end the response, drop it.
            setTimeout(() => res.destroy(), 1_000).unref();
          },
          Math.max(0, expiresAt - Date.now()),
        );
  timer?.unref();
  req.once("close", () => {
    clearTimeout(timer);
    if (expired) return;
    // A stream the server opened and did not end is one the client dropped.
    if (res.headersSent && res.statusCode === 200 && !res.writableFinished) {
      transport.closeStandaloneSSEStream();
    }
  });
}
