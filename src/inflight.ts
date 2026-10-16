/**
 * JSON-RPC request ids in flight in one hosted MCP session.
 *
 * The SDK's Streamable HTTP transport sends each response on the HTTP
 * stream of the request with the same id. A second request that reuses an
 * id in flight would get the first one's response. Two tokens of one
 * subject, with different scopes, can share a session, so a browse-only
 * request could read a list_secret_refs result. src/http.ts refuses a
 * request whose id is in flight.
 *
 * An id the server received stays reserved until the server has answered
 * it or aborted it on a cancel. After a client disconnect the SDK still maps
 * the id and would send the late answer to the next request that uses it,
 * and on Bun 1.3.x and earlier node:http emits no event on the server when
 * a POST client disconnects, so the HTTP response is no signal for these.
 * An id the transport refused before the server saw it is reserved until
 * that HTTP response has ended. A cancel that arrives before its request does nothing
 * to the server, which still answers, so it does not settle the id either.
 */
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/server";

type Entry = {
  httpDone: boolean;
  /** The transport gave the request to the server. */
  dispatched: boolean;
  /** The server answered, or the client cancelled a dispatched request. */
  settled: boolean;
};

const isId = (id: unknown): id is RequestId =>
  typeof id === "string" || typeof id === "number";

/** Ids of the requests in a POST body. Notifications and responses have no
 * id that the transport maps. */
function requestIds(body: unknown): RequestId[] {
  const messages = Array.isArray(body) ? body : [body];
  const ids: RequestId[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const { method, id } = m as { method?: unknown; id?: unknown };
    if (typeof method === "string" && isId(id)) ids.push(id);
  }
  return ids;
}

export class InFlightIds {
  private readonly entries = new Map<RequestId, Entry>();

  /**
   * Reserve a POST body's request ids, or refuse the whole body when an id
   * is in flight or appears twice. Call `done` when the HTTP response ends;
   * it frees the ids the transport never gave to the server.
   */
  reserve(
    body: unknown,
  ): { ok: true; done: () => void } | { ok: false; id: RequestId } {
    const ids = requestIds(body);
    const seen = new Set<RequestId>();
    for (const id of ids) {
      if (this.entries.has(id) || seen.has(id)) return { ok: false, id };
      seen.add(id);
    }
    const mine = ids.map((id) => {
      const entry = { httpDone: false, dispatched: false, settled: false };
      this.entries.set(id, entry);
      return [id, entry] as const;
    });
    let called = false;
    return {
      ok: true,
      done: () => {
        if (called) return;
        called = true;
        for (const [id, entry] of mine) {
          entry.httpDone = true;
          this.releaseIfFree(id, entry);
        }
      },
    };
  }

  /** A message the transport gives to the server. */
  inbound(message: JSONRPCMessage): void {
    const m = message as {
      method?: unknown;
      id?: unknown;
      params?: { requestId?: unknown };
    };
    if (typeof m.method !== "string") return;
    if (isId(m.id)) {
      const entry = this.entries.get(m.id);
      if (entry) entry.dispatched = true;
    } else if (m.method === "notifications/cancelled") {
      // The server drops the answer to a dispatched request it cancels.
      this.settle(m.params?.requestId);
    }
  }

  /** A message the server sent through the transport. */
  outbound(message: JSONRPCMessage): void {
    const m = message as { method?: unknown; id?: unknown };
    if (m.method === undefined) this.settle(m.id);
  }

  private settle(id: unknown): void {
    if (!isId(id)) return;
    const entry = this.entries.get(id);
    if (!entry || !entry.dispatched) return;
    entry.settled = true;
    this.releaseIfFree(id, entry);
  }

  private releaseIfFree(id: RequestId, entry: Entry): void {
    const free = entry.dispatched ? entry.settled : entry.httpDone;
    if (free && this.entries.get(id) === entry) this.entries.delete(id);
  }
}
