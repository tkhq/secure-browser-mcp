import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  InvalidTokenError,
  JwksCache,
  MAX_TOKEN_LIFETIME_S,
  verifyAccessToken,
} from "../src/auth/tokens.js";
import { MockAuthServer, type MintOptions } from "./mock-auth-server.js";

/** src/auth/tokens.ts against a live JWKS. */

const AUDIENCE = "https://sbm.example.com/t/acme/mcp";
const DAY = MAX_TOKEN_LIFETIME_S;
let as: MockAuthServer;
let other: MockAuthServer;
const jwks = new JwksCache();

beforeAll(async () => {
  as = await MockAuthServer.start();
  other = await MockAuthServer.start();
});

afterAll(() => {
  as.stop();
  other.stop();
});

type Expect = Parameters<typeof verifyAccessToken>[1];
const expectFor = (more: Partial<Expect> = {}): Expect => ({
  audience: AUDIENCE,
  issuers: [{ issuer: as.issuer, jwksUri: as.jwksUri }],
  ...more,
});
const mint = (opts: MintOptions = {}) => as.mint({ aud: AUDIENCE, ...opts });
const verify = (token: string, want = expectFor(), cache = jwks) =>
  verifyAccessToken(token, want, cache);

async function rejects(token: string, want = expectFor(), cache = jwks) {
  const err = await verify(token, want, cache).catch((e) => e);
  expect(err).toBeInstanceOf(InvalidTokenError);
}

test("accepts a valid token and reports its principal, client, and scopes", async () => {
  const p = await verify(
    await mint({ sub: "alice", scope: "sbm:browse", scp: ["sbm:fill"] }),
  );
  expect(p.issuer).toBe(as.issuer);
  expect(p.subject).toBe("alice");
  expect(p.client).toBeUndefined();
  // scope and scp (Okta) are merged.
  expect([...p.scopes].sort()).toEqual(["sbm:browse", "sbm:fill"]);
  expect([...(await verify(await mint({ scp: "sbm:refs" }))).scopes]).toEqual([
    "sbm:refs",
  ]);

  // Small clock skew is tolerated.
  await verify(await mint({ expiresIn: -5, notBefore: 5 }));
  // Up to a day of lifetime is fine, with or without iat.
  await verify(await mint({ expiresIn: DAY }));
  await verify(await mint({ expiresIn: DAY, omitIat: true }));
});

test("rejects tokens that fail a claim check", async () => {
  const bad: [string, MintOptions][] = [
    ["expired", { expiresIn: -120 }],
    ["not yet valid", { notBefore: 120 }],
    ["no exp", { omitExp: true }],
    ["no sub", { omitSub: true }],
    ["another tenant", { aud: "https://sbm.example.com/t/other/mcp" }],
    ["near-miss aud", { aud: `${AUDIENCE}/` }],
    ["extra aud", { aud: [AUDIENCE, "https://api.other.com"] }],
    ["over a day left", { expiresIn: DAY + 120 }],
    ["over a day, no iat", { expiresIn: DAY + 120, omitIat: true }],
    // Issued two days ago for three days: a day left, but too long a life.
    ["lifetime > a day", { issuedAt: -2 * DAY, expiresIn: DAY - 60 }],
  ];
  // ID tokens, whatever their typ.
  for (const claims of [
    { nonce: "n-1" },
    { at_hash: "abc" },
    { c_hash: "abc" },
  ]) {
    for (const typ of ["JWT", "at+jwt", null]) {
      bad.push([`ID token ${typ}`, { claims, typ }]);
    }
  }
  for (const [, opts] of bad) await rejects(await mint(opts));
  await rejects(await as.mint({})); // no aud
});

test("rejects untrusted issuers, unknown keys, and weak algorithms", async () => {
  await rejects(await other.mint({ aud: AUDIENCE }));
  // Claims the trusted issuer, but signed with a key its JWKS lacks.
  await rejects(await other.mint({ aud: AUDIENCE, iss: as.issuer }));
  await rejects(await as.mintWithUnpublishedKey({ aud: AUDIENCE }));

  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = b64({
    iss: as.issuer,
    aud: AUDIENCE,
    sub: "alice",
    exp: Math.floor(Date.now() / 1000) + 300,
  });
  await rejects(`${b64({ alg: "none" })}.${claims}.`);
  await rejects(`${b64({ alg: "HS256" })}.${claims}.c2ln`);
  await rejects("not-a-jwt");
});

test("checks typ: at+jwt only for an issuer with requireTyp", async () => {
  const strict = expectFor({
    issuers: [{ issuer: as.issuer, jwksUri: as.jwksUri, requireTyp: true }],
  });
  for (const typ of ["JWT", null]) {
    await verify(await mint({ typ }));
    await rejects(await mint({ typ }), strict);
  }
  for (const typ of ["at+jwt", "application/at+JWT"]) {
    await verify(await mint({ typ }), strict);
  }
});

test("with allowedClients, accepts only those clients, by azp else client_id", async () => {
  const only = expectFor({ allowedClients: ["agent-app"] });
  for (const claims of [{ azp: "agent-app" }, { client_id: "agent-app" }]) {
    expect((await verify(await mint({ claims }), only)).client).toBe(
      "agent-app",
    );
  }
  for (const claims of [
    {},
    { azp: "rogue-app" },
    { client_id: "rogue-app" },
    // azp names the client when both are present.
    { azp: "rogue-app", client_id: "agent-app" },
  ]) {
    await rejects(await mint({ claims }), only);
  }
});

test("caches the JWKS, and fails closed when it cannot be fetched", async () => {
  const cache = new JwksCache();
  const before = as.fetches;
  await verify(await mint(), expectFor(), cache);
  await verify(await mint(), expectFor(), cache);
  expect(as.fetches - before).toBe(1);

  as.down = true;
  try {
    await rejects(await mint(), expectFor(), new JwksCache());
  } finally {
    as.down = false;
  }
});
