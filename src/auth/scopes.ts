/**
 * OAuth scopes for the hosted broker (docs/HOSTED.md, "Scopes"). Every tool
 * declares exactly one in its definition, so a new tool cannot ship without
 * one. The stdio broker has no tokens and ignores them.
 *
 *  - sbm:browse  drive the browser: navigate, snapshot, click, type_text,
 *                list_network_requests
 *  - sbm:fill    put a secret into the page: fill_secret, await_fill
 *  - sbm:refs    see which secrets exist: list_secret_refs
 */
export const SCOPES = ["sbm:browse", "sbm:fill", "sbm:refs"] as const;

export type Scope = (typeof SCOPES)[number];

/** Space-separated scopes from a token's `scope` claim (RFC 9068 §2.2.3). */
export function parseScopes(claim: unknown): Set<string> {
  if (typeof claim !== "string") return new Set();
  return new Set(claim.split(" ").filter(Boolean));
}
