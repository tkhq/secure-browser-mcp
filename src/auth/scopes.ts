/**
 * OAuth scopes for the hosted broker (docs/HOSTED.md, "Scopes"). Every tool
 * declares one in its definition (ToolDef.scope), so a new tool cannot ship
 * without one. The stdio broker ignores them.
 */
export const SCOPES = ["sbm:browse", "sbm:fill", "sbm:refs"] as const;

export type Scope = (typeof SCOPES)[number];

/** The union of `scope` (RFC 9068, space-separated) and `scp` (Okta and
 * others: a string or an array of strings). */
export function parseScopes(claims: {
  scope?: unknown;
  scp?: unknown;
}): Set<string> {
  const scopes = new Set<string>();
  for (const claim of [claims.scope, claims.scp]) {
    const parts =
      typeof claim === "string"
        ? claim.split(" ")
        : Array.isArray(claim)
          ? claim.filter((s): s is string => typeof s === "string")
          : [];
    for (const s of parts) if (s) scopes.add(s);
  }
  return scopes;
}
