/**
 * Access-token validation for the hosted broker, an OAuth 2.1 resource
 * server. The rules are in docs/HOSTED.md ("Authorization"). They follow
 * RFC 9068 with two differences: `typ: at+jwt` is checked only for an
 * issuer with `requireTyp` (on by default when the tenant overrides its
 * audience, see tenantIssuers), because many servers do not send it; and
 * `aud` must be a single value.
 *
 * Every failure, including a JWKS that cannot be fetched, rejects the
 * token. The token itself goes nowhere: not to Turnkey, not to Browserbase,
 * not to the logs.
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

/** The longest lifetime the broker accepts, so a stolen token works for a
 * day at most. */
export const MAX_TOKEN_LIFETIME_S = 24 * 60 * 60;

const ALGORITHMS = ["RS256", "PS256", "ES256", "ES384", "EdDSA"];

/** Who a validated token speaks for. */
export type Principal = {
  issuer: string;
  subject: string;
  /** `azp`, else `client_id`. Undefined when the token names no client:
   * then nothing binds the caller to a client, only to (iss, sub). */
  client: string | undefined;
  scopes: Set<string>;
  /** `exp`, in seconds since the epoch. */
  expiresAt: number;
};

export class InvalidTokenError extends Error {
  override name = "InvalidTokenError";
}

/** One remote key set per JWKS URI, shared by every tenant that trusts the
 * issuer. jose caches it and refetches for an unknown kid. */
export class JwksCache {
  private readonly sets = new Map<string, JWTVerifyGetKey>();

  get(jwksUri: string): JWTVerifyGetKey {
    let set = this.sets.get(jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUri), {
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        timeoutDuration: 5_000,
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
    allowedClients?: readonly string[] | undefined;
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

  // jose accepts an aud array that merely contains the audience.
  const aud = payload.aud;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (audiences.length !== 1 || audiences[0] !== expect.audience) {
    throw new InvalidTokenError("Token audience is not this resource");
  }
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new InvalidTokenError("Token has no subject");
  }
  // nonce, at_hash, and c_hash mark an OpenID Connect ID token. Not
  // checked by typ, since Entra ID and others send `typ: JWT` on access
  // tokens too.
  if ("nonce" in payload || "at_hash" in payload || "c_hash" in payload) {
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
  const client = [payload["azp"], payload["client_id"]].find(
    (c): c is string => typeof c === "string" && c !== "",
  );
  // With allowedClients, a token must name its client. Without the list, a
  // token without a client claim is bound to (iss, sub) only.
  if (
    expect.allowedClients &&
    (client === undefined || !expect.allowedClients.includes(client))
  ) {
    throw new InvalidTokenError("Token client is not allowed");
  }
  return {
    issuer: trusted.issuer,
    subject: payload.sub,
    client,
    scopes: parseScopes(payload),
    expiresAt: exp,
  };
}
