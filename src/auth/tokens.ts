/**
 * Access-token validation for the hosted broker. The broker is an OAuth 2.1
 * resource server: it accepts JWT access tokens (RFC 9068) from the
 * authorization servers a tenant trusts, and nothing else.
 *
 * A token is accepted for a tenant only when all of these hold:
 *  - its `iss` is one of the tenant's trusted issuers, exactly;
 *  - its signature verifies against that issuer's JWKS, with an asymmetric
 *    algorithm (never `none`, never HMAC);
 *  - its `aud` is exactly the tenant's resource URI (RFC 8707): a token for
 *    tenant A is not a token for tenant B, or for any other service;
 *  - `exp` is present and in the future, and `nbf`, when present, is in the
 *    past, both with CLOCK_SKEW_S of tolerance;
 *  - it names a subject (`sub`).
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

const ALGORITHMS = ["RS256", "PS256", "ES256", "ES384", "EdDSA"];

/** Who a validated token speaks for. */
export type Principal = {
  issuer: string;
  subject: string;
  scopes: Set<string>;
};

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
  expect: { audience: string; issuers: TrustedIssuer[] },
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
  return {
    issuer: trusted.issuer,
    subject: payload.sub,
    scopes: parseScopes(payload["scope"]),
  };
}
