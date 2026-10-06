/**
 * Test-only authorization server: publishes a JWKS over HTTP and mints JWT
 * access tokens signed with its current key. Not an OAuth implementation;
 * it has no endpoints but the JWKS, because the broker only ever reads the
 * key set.
 */
import { randomUUID } from "node:crypto";

import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";

type Key = { kid: string; privateKey: CryptoKey; publicJwk: JWK };

export type MintOptions = {
  sub?: string;
  aud?: string | string[];
  scope?: string;
  /** Okta-style scopes claim. */
  scp?: string | string[];
  /** Seconds from now; negative for an expired token. */
  expiresIn?: number;
  /** Seconds from now. */
  notBefore?: number;
  /** Override `iss` (for a token claiming another issuer). */
  iss?: string;
  omitExp?: boolean;
  omitSub?: boolean;
};

export class MockAuthServer {
  readonly issuer: string;
  readonly jwksUri: string;
  /** JWKS fetches served, for cache assertions. */
  fetches = 0;
  /** While true the JWKS endpoint answers 503. */
  down = false;
  private keys: Key[] = [];
  private server: ReturnType<typeof Bun.serve>;

  private constructor(server: ReturnType<typeof Bun.serve>) {
    this.server = server;
    this.issuer = `http://127.0.0.1:${server.port}`;
    this.jwksUri = `${this.issuer}/jwks.json`;
  }

  static async start(): Promise<MockAuthServer> {
    let self: MockAuthServer | undefined;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        if (new URL(req.url).pathname !== "/jwks.json")
          return new Response("not found", { status: 404 });
        self!.fetches++;
        if (self!.down) return new Response("down", { status: 503 });
        return Response.json({ keys: self!.keys.map((k) => k.publicJwk) });
      },
    });
    self = new MockAuthServer(server);
    await self.rotate();
    return self;
  }

  /** Publish a new signing key; later tokens use it. Old keys stay
   * published unless `retire` is set. */
  async rotate(retire = false): Promise<string> {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const kid = randomUUID();
    const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256" };
    this.keys = retire
      ? [{ kid, privateKey, publicJwk }]
      : [...this.keys, { kid, privateKey, publicJwk }];
    return kid;
  }

  /** Sign with a key that was never published. */
  async mintWithUnpublishedKey(opts: MintOptions): Promise<string> {
    const { privateKey } = await generateKeyPair("ES256");
    return this.sign({ kid: "unpublished", privateKey, publicJwk: {} }, opts);
  }

  mint(opts: MintOptions = {}): Promise<string> {
    return this.sign(this.keys[this.keys.length - 1]!, opts);
  }

  private sign(key: Key, opts: MintOptions): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {};
    if (opts.scope !== undefined) claims["scope"] = opts.scope;
    if (opts.scp !== undefined) claims["scp"] = opts.scp;
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "at+jwt" })
      .setIssuer(opts.iss ?? this.issuer)
      .setIssuedAt(now)
      .setJti(randomUUID());
    if (opts.aud !== undefined) jwt.setAudience(opts.aud);
    if (!opts.omitSub) jwt.setSubject(opts.sub ?? "user-1");
    if (!opts.omitExp) jwt.setExpirationTime(now + (opts.expiresIn ?? 300));
    if (opts.notBefore !== undefined) jwt.setNotBefore(now + opts.notBefore);
    return jwt.sign(key.privateKey);
  }

  stop(): void {
    this.server.stop(true);
  }
}
