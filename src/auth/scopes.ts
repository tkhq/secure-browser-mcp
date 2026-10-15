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

/**
 * Scopes from a token's claims. RFC 9068 §2.2.3 puts them in `scope`, a
 * space-separated string. Okta and some other servers use `scp` instead,
 * as a string or an array of strings. The broker reads both and takes the
 * union; a claim of any other shape adds nothing.
 */
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
