/**
 * JSON-RPC request ids in flight in one hosted MCP session.
 *
 * The SDK's Streamable HTTP transport sends each response on the HTTP
 * stream of the request with the same JSON-RPC id. A second request that
 * reuses an id while the first is in flight takes over the first one's
 * stream, and gets its response. Two tokens of the same subject, with
 * different scopes, can share a session, so this would let a browse-only
 * request read a list_secret_refs result. The broker refuses a request
 * whose id is in flight in its session (src/http.ts).
 *
 * An id stays reserved until both of these are true:
 *  - the HTTP response that carried the request has ended, and
 *  - the server answered the id, the client cancelled it, or the request
 *    never reached the server (the transport refused the POST).
 * The second condition matters when a client disconnects during a call:
 * the SDK still maps the id, and would send the late answer to the next
 * request that uses the id.
 */
import type { JSONRPCMessage, RequestId } from "@modelcontextprotocol/server";

type Entry = {
  /** The HTTP response that carried the request has ended. */
  httpDone: boolean;
  /** The transport gave the request to the server. */
  dispatched: boolean;
  /** The server answered, or the client cancelled the request. */
  settled: boolean;
};

const isId = (id: unknown): id is RequestId =>
  typeof id === "string" || typeof id === "number";

/** The ids of the requests (messages with a method and an id) in a POST
 * body. Notifications and responses have no id that the transport maps. */
export function requestIds(body: unknown): RequestId[] {
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
   * Reserve the request ids of a POST body. Refuses the whole body when an
   * id is in flight, or appears twice in the body. On success, call `done`
   * when the HTTP response ends; it is safe to call more than once.
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
      // The server drops the answer to a cancelled request.
      this.settle(m.params?.requestId);
    }
  }

  /** A message the server sent through the transport. */
  outbound(message: JSONRPCMessage): void {
    const m = message as { method?: unknown; id?: unknown };
    if (m.method === undefined) this.settle(m.id);
  }

  has(id: RequestId): boolean {
    return this.entries.has(id);
  }

  private settle(id: unknown): void {
    if (!isId(id)) return;
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.settled = true;
    this.releaseIfFree(id, entry);
  }

  private releaseIfFree(id: RequestId, entry: Entry): void {
    if (
      entry.httpDone &&
      (entry.settled || !entry.dispatched) &&
      this.entries.get(id) === entry
    ) {
      this.entries.delete(id);
    }
  }
}
