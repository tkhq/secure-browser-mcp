import type { RedactionRegistry } from "./registry.js";

/**
 * The single choke point between tool handlers and the agent: `server.ts`
 * pipes EVERY tool result through this before returning it over MCP. Tool
 * handlers never serialize their own output to the transport.
 *
 * Today: recursive value-scan over all string content. TODO(scaffold):
 * structural redaction — snapshot serializers consult
 * `registry.isTaggedField()` and elide tagged input values outright, and the
 * network-log tool drops request bodies for origins with live secrets.
 */
export function scrub<T>(registry: RedactionRegistry, output: T): T {
  return scrubValue(registry, output) as T;
}

function scrubValue(registry: RedactionRegistry, value: unknown): unknown {
  if (typeof value === "string") return registry.scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(registry, v));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, scrubValue(registry, v)]),
    );
  }
  return value;
}
