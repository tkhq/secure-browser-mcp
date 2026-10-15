import { expect, test } from "bun:test";

import {
  checkAudiences,
  metadataUri,
  parsePublicUrl,
  parseTenants,
  resolveApiKey,
  resourceUri,
  tenantAudience,
} from "../src/auth/tenants.js";

const issuers = [
  {
    issuer: "https://login.acme.com",
    jwksUri: "https://login.acme.com/jwks.json",
  },
];

test("rejects missing keys, inline keys, bad ids, duplicates, and insecure issuers", () => {
  const base = { organizationId: "o", apiKey: { path: "/k.json" }, issuers };
  expect(parseTenants({ tenants: [{ ...base, id: "a" }] })[0]?.backend).toBe(
    "turnkey",
  );
  const bad: [unknown[], RegExp][] = [
    [[{ id: "a", issuers, apiKey: { path: "x" } }], /organizationId/],
    [[{ id: "a", issuers, organizationId: "o" }], /apiKey/],
    [[{ ...base, id: "a", apiKey: { privateKey: "secret" } }], /apiKey/],
    [[{ ...base, id: "../x" }], /id/],
    [
      [
        { ...base, id: "a" },
        { ...base, id: "a" },
      ],
      /Duplicate/,
    ],
    [
      [
        {
          ...base,
          id: "a",
          issuers: [{ issuer: "http://x.com", jwksUri: "x" }],
        },
      ],
      /https/,
    ],
    [[], /tenants/],
  ];
  for (const [tenants, message] of bad) {
    expect(() => parseTenants({ tenants })).toThrow(message);
  }
});

test("resolves an API key from the environment, never from the file", () => {
  const [t] = parseTenants({
    tenants: [
      {
        id: "acme",
        organizationId: "o",
        apiKey: { publicKeyEnv: "T_PUB", privateKeyEnv: "T_PRIV" },
        issuers,
      },
    ],
  });
  if (t?.backend !== "turnkey") throw new Error("expected turnkey");
  expect(() => resolveApiKey(t)).toThrow(/T_PUB/);
  process.env["T_PUB"] = "pub";
  process.env["T_PRIV"] = "priv";
  expect(resolveApiKey(t)).toEqual({
    apiPublicKey: "pub",
    apiPrivateKey: "priv",
  });
  delete process.env["T_PUB"];
  delete process.env["T_PRIV"];
});

test("resource and metadata URIs follow RFC 8707 and RFC 9728", () => {
  const base = parsePublicUrl("https://sbm.example.com/");
  expect(resourceUri(base, "acme")).toBe("https://sbm.example.com/t/acme/mcp");
  expect(metadataUri(base, "acme")).toBe(
    "https://sbm.example.com/.well-known/oauth-protected-resource/t/acme/mcp",
  );
  expect(() => parsePublicUrl("http://sbm.example.com")).toThrow();
  expect(() => parsePublicUrl("https://sbm.example.com/prefix")).toThrow();
  expect(parsePublicUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
});

test("a tenant's audience defaults to its resource URI and must be unique", () => {
  const base = "https://sbm.example.com";
  const tenants = parseTenants({
    tenants: [
      { id: "acme", backend: "mock", issuers },
      { id: "globex", backend: "mock", issuers, audience: "api://globex" },
    ],
  });
  expect(tenantAudience(base, tenants[0]!)).toBe(resourceUri(base, "acme"));
  expect(tenantAudience(base, tenants[1]!)).toBe("api://globex");
  expect(() => checkAudiences(base, tenants)).not.toThrow();

  // An override that collides with another tenant would let one tenant's
  // tokens work at the other.
  const clash = parseTenants({
    tenants: [
      { id: "acme", backend: "mock", issuers },
      {
        id: "globex",
        backend: "mock",
        issuers,
        audience: resourceUri(base, "acme"),
      },
    ],
  });
  expect(() => checkAudiences(base, clash)).toThrow(/same token audience/);
});
