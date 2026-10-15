/**
 * Access-token validation for the hosted broker. The broker is an OAuth 2.1
 * resource server: it accepts signed JWT access tokens from the
 * authorization servers a tenant trusts, and nothing else. The checks follow
 * the JWT access-token profile (RFC 9068) except where noted: the `typ:
 * at+jwt` header is checked only for an issuer with `requireTyp`, because
 * many authorization servers send `typ: JWT` or no `typ`; and `aud` must be
 * a single value, which is stricter than RFC 9068.
 *
 * A token is accepted for a tenant only when all of these hold:
 *  - its `iss` is one of the tenant's trusted issuers, exactly;
 *  - its signature verifies against that issuer's JWKS, with an asymmetric
 *    algorithm (never `none`, never HMAC);
 *  - its `aud` is exactly the tenant's audience (RFC 8707), and nothing
 *    else: by default the tenant's resource URI, or the tenant's `audience`
 *    override. A token for tenant A is not a token for tenant B, or for any
 *    other service;
 *  - for an issuer with `requireTyp`, its header has `typ: at+jwt`;
 *  - `exp` is present and in the future, and `nbf`, when present, is in the
 *    past, both with CLOCK_SKEW_S of tolerance;
 *  - `exp` is at most MAX_TOKEN_LIFETIME_S (24 hours) after now, and at
 *    most that long after `iat` when the token has one. A stolen token
 *    then works for a day at most;
 *  - it has no `nonce` or `at_hash` claim. Those mark an OpenID Connect ID
 *    token, which tells the client who signed in and is not an access
 *    token. This check does not depend on `typ`, since Entra ID and others
 *    send `typ: JWT` on access tokens too;
 *  - it names a subject (`sub`);
 *  - for a tenant with `allowedClients`, its client (`azp`, else
 *    `client_id`) is in that list. Without the list, every client the
 *    authorization server issues tokens to is trusted.
 *
 * Any failure, including a JWKS that cannot be fetched, rejects the token.
 * The token itself goes nowhere: not to Turnkey, not to Browserbase, not to
 * the logs.
 */
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

import { parseScopes } from "./scopes.js";
import type { TrustedIssuer } from "./tenants.js";

export const CLOCK_SKEW_S = 30;

/** The longest lifetime the broker accepts in a token. */
export const MAX_TOKEN_LIFETIME_S = 24 * 60 * 60;

const ALGORITHMS = ["RS256", "PS256", "ES256", "ES384", "EdDSA"];

/** Who a validated token speaks for. */
export type Principal = {
  issuer: string;
  subject: string;
  /** The OAuth client the token was issued to (`azp`, else `client_id`),
   * when the token names one. */
  client?: string;
  scopes: Set<string>;
};

/** The client a token was issued to. OpenID Connect and Keycloak use
 * `azp`; RFC 9068 uses `client_id`. */
function tokenClient(payload: {
  azp?: unknown;
  client_id?: unknown;
}): string | undefined {
  for (const claim of [payload.azp, payload.client_id]) {
    if (typeof claim === "string" && claim !== "") return claim;
  }
  return undefined;
}

export class InvalidTokenError extends Error {
  override name = "InvalidTokenError";
}

export type JwksOptions = {
  /** Minimum time between refetches when a token names an unknown kid. */
  cooldownMs?: number;
  /** How long fetched keys are trusted before a refetch. */
  cacheMaxAgeMs?: number;
  timeoutMs?: number;
};

/**
 * One cached key set per JWKS URI, shared by every tenant that trusts the
 * issuer. jose's remote key set fetches lazily, caches, refetches when a
 * token names a kid it does not have (at most once per cooldown), and
 * fails when the fetch fails.
 */
export class JwksCache {
  private readonly sets = new Map<string, JWTVerifyGetKey>();

  constructor(private readonly opts: JwksOptions = {}) {}

  get(jwksUri: string): JWTVerifyGetKey {
    let set = this.sets.get(jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUri), {
        cooldownDuration: this.opts.cooldownMs ?? 30_000,
        cacheMaxAge: this.opts.cacheMaxAgeMs ?? 10 * 60_000,
        timeoutDuration: this.opts.timeoutMs ?? 5_000,
      });
      this.sets.set(jwksUri, set);
    }
    return set;
  }
}

export async function verifyAccessToken(
  token: string,
  expect: {
    audience: string;
    issuers: TrustedIssuer[];
    allowedClients?: readonly string[];
  },
  jwks: JwksCache,
): Promise<Principal> {
  // Pick the key set by the unverified issuer, then verify that exact
  // issuer: a token cannot choose a key set its tenant does not trust.
  let unverifiedIss: unknown;
  try {
    unverifiedIss = decodeJwt(token).iss;
  } catch {
    throw new InvalidTokenError("Malformed token");
  }
  const trusted = expect.issuers.find((i) => i.issuer === unverifiedIss);
  if (!trusted) throw new InvalidTokenError("Untrusted issuer");

  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks.get(trusted.jwksUri), {
      issuer: trusted.issuer,
      audience: expect.audience,
      algorithms: ALGORITHMS,
      clockTolerance: CLOCK_SKEW_S,
      requiredClaims: ["exp", "sub"],
      // jose compares typ case-insensitively and accepts application/at+jwt.
      ...(trusted.requireTyp ? { typ: "at+jwt" } : {}),
    }));
  } catch {
    // jose's message can carry claim values; keep the reason generic.
    throw new InvalidTokenError("Token rejected");
  }

  // jose accepts an aud array that merely contains the audience. Require
  // the token to be for this resource alone.
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (audiences.length !== 1 || audiences[0] !== expect.audience) {
    throw new InvalidTokenError("Token audience is not this resource");
  }
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new InvalidTokenError("Token has no subject");
  }
  if ("nonce" in payload || "at_hash" in payload) {
    throw new InvalidTokenError("Token is an ID token");
  }
  // jose has checked that exp (required) and iat (if present) are numbers.
  const exp = payload.exp!;
  const now = Math.floor(Date.now() / 1000);
  if (
    exp > now + MAX_TOKEN_LIFETIME_S + CLOCK_SKEW_S ||
    (payload.iat !== undefined && exp - payload.iat > MAX_TOKEN_LIFETIME_S)
  ) {
    throw new InvalidTokenError("Token lifetime is too long");
  }
  const client = tokenClient(payload);
  if (
    expect.allowedClients &&
    (client === undefined || !expect.allowedClients.includes(client))
  ) {
    throw new InvalidTokenError("Token client is not allowed");
  }
  return {
    issuer: trusted.issuer,
    subject: payload.sub,
    ...(client !== undefined ? { client } : {}),
    scopes: parseScopes(payload),
  };
}
