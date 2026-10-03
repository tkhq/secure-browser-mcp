import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  InvalidTokenError,
  JwksCache,
  verifyAccessToken,
} from "../src/auth/tokens.js";
import { MockAuthServer } from "./mock-auth-server.js";

/** src/auth/tokens.ts against a live JWKS. */

const AUDIENCE = "https://sbm.example.com/t/acme/mcp";
let as: MockAuthServer;
let other: MockAuthServer;

beforeAll(async () => {
  as = await MockAuthServer.start();
  other = await MockAuthServer.start();
});

afterAll(() => {
  as.stop();
  other.stop();
});

const expectFor = () => ({
  audience: AUDIENCE,
  issuers: [{ issuer: as.issuer, jwksUri: as.jwksUri }],
});

async function rejects(token: string, jwks = new JwksCache()) {
  const err = await verifyAccessToken(token, expectFor(), jwks).catch((e) => e);
  expect(err).toBeInstanceOf(InvalidTokenError);
}

test("accepts a valid token and reports its principal and scopes", async () => {
  const token = await as.mint({
    aud: AUDIENCE,
    sub: "alice",
    scope: "sbm:browse sbm:fill",
  });
  const p = await verifyAccessToken(token, expectFor(), new JwksCache());
  expect(p.issuer).toBe(as.issuer);
  expect(p.subject).toBe("alice");
  expect([...p.scopes].sort()).toEqual(["sbm:browse", "sbm:fill"]);
});

test("reads Okta-style scp scopes, as an array or a string", async () => {
  const jwks = new JwksCache();
  const scopesOf = async (claims: {
    scope?: string;
    scp?: string | string[];
  }) =>
    [
      ...(
        await verifyAccessToken(
          await as.mint({ aud: AUDIENCE, ...claims }),
          expectFor(),
          jwks,
        )
      ).scopes,
    ].sort();
  expect(await scopesOf({ scp: ["sbm:refs", "sbm:browse"] })).toEqual([
    "sbm:browse",
    "sbm:refs",
  ]);
  expect(await scopesOf({ scp: "sbm:fill" })).toEqual(["sbm:fill"]);
  expect(await scopesOf({ scope: "sbm:browse", scp: ["sbm:fill"] })).toEqual([
    "sbm:browse",
    "sbm:fill",
  ]);
});

test("accepts a client-credentials token: a client id as sub, no user claims", async () => {
  const token = await as.mint({
    aud: AUDIENCE,
    sub: "svc-agent@clients",
    scope: "sbm:browse sbm:fill sbm:refs",
  });
  const p = await verifyAccessToken(token, expectFor(), new JwksCache());
  expect(p.subject).toBe("svc-agent@clients");
  expect(p.scopes.size).toBe(3);
});

test("rejects expired, not-yet-valid, and exp-less tokens", async () => {
  await rejects(await as.mint({ aud: AUDIENCE, expiresIn: -120 }));
  await rejects(await as.mint({ aud: AUDIENCE, notBefore: 120 }));
  await rejects(await as.mint({ aud: AUDIENCE, omitExp: true }));
});

test("tolerates small clock skew", async () => {
  const jwks = new JwksCache();
  const skewed = await as.mint({ aud: AUDIENCE, expiresIn: -5, notBefore: 5 });
  await expect(
    verifyAccessToken(skewed, expectFor(), jwks),
  ).resolves.toBeDefined();
});

test("rejects a token without a subject", async () => {
  await rejects(await as.mint({ aud: AUDIENCE, omitSub: true }));
});

test("rejects the wrong audience, and audiences beyond this resource", async () => {
  await rejects(await as.mint({ aud: "https://sbm.example.com/t/other/mcp" }));
  await rejects(await as.mint({ aud: `${AUDIENCE}/` }));
  await rejects(await as.mint({}));
  await rejects(await as.mint({ aud: [AUDIENCE, "https://api.other.com"] }));
});

test("rejects untrusted issuers, including one claiming a trusted iss", async () => {
  await rejects(await other.mint({ aud: AUDIENCE }));
  // Signed by another server's key but claims the trusted issuer: the
  // trusted issuer's JWKS does not have that key.
  await rejects(await other.mint({ aud: AUDIENCE, iss: as.issuer }));
  await rejects(await as.mintWithUnpublishedKey({ aud: AUDIENCE }));
});

test("rejects unsigned and HMAC tokens", async () => {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = {
    iss: as.issuer,
    aud: AUDIENCE,
    sub: "alice",
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  await rejects(`${b64({ alg: "none" })}.${b64(claims)}.`);
  await rejects(`${b64({ alg: "HS256" })}.${b64(claims)}.c2ln`);
  await rejects("not-a-jwt");
});

test("caches the JWKS and refetches for an unknown kid", async () => {
  const jwks = new JwksCache({ cooldownMs: 0 });
  const before = as.fetches;
  await verifyAccessToken(await as.mint({ aud: AUDIENCE }), expectFor(), jwks);
  await verifyAccessToken(await as.mint({ aud: AUDIENCE }), expectFor(), jwks);
  expect(as.fetches - before).toBe(1);

  await as.rotate(true);
  const p = await verifyAccessToken(
    await as.mint({ aud: AUDIENCE, sub: "after-rotation" }),
    expectFor(),
    jwks,
  );
  expect(p.subject).toBe("after-rotation");
  expect(as.fetches - before).toBe(2);
});

test("fails closed when the JWKS cannot be fetched", async () => {
  const token = await as.mint({ aud: AUDIENCE });
  as.down = true;
  try {
    await rejects(token, new JwksCache());
  } finally {
    as.down = false;
  }
});
