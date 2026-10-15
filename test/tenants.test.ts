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

test("a turnkey tenant needs an organization and an API key reference", () => {
  const [t] = parseTenants({
    tenants: [
      {
        id: "acme",
        organizationId: "org-1",
        apiKey: { publicKeyEnv: "ACME_PUB", privateKeyEnv: "ACME_PRIV" },
        issuers,
      },
    ],
  });
  expect(t?.backend).toBe("turnkey");
  expect(() =>
    parseTenants({ tenants: [{ id: "acme", issuers, apiKey: { path: "x" } }] }),
  ).toThrow(/organizationId/);
  expect(() =>
    parseTenants({ tenants: [{ id: "acme", issuers, organizationId: "o" }] }),
  ).toThrow(/apiKey/);
});

test("rejects keys inline, bad ids, duplicates, and insecure issuers", () => {
  const base = { organizationId: "o", apiKey: { path: "/k.json" }, issuers };
  expect(() =>
    parseTenants({
      tenants: [{ ...base, id: "a", apiKey: { privateKey: "secret" } }],
    }),
  ).toThrow();
  expect(() => parseTenants({ tenants: [{ ...base, id: "../x" }] })).toThrow(
    /id/,
  );
  expect(() =>
    parseTenants({
      tenants: [
        { ...base, id: "a" },
        { ...base, id: "a" },
      ],
    }),
  ).toThrow(/Duplicate/);
  expect(() =>
    parseTenants({
      tenants: [
        {
          ...base,
          id: "a",
          issuers: [{ issuer: "http://login.acme.com", jwksUri: "x" }],
        },
      ],
    }),
  ).toThrow(/https/);
  expect(() => parseTenants({ tenants: [] })).toThrow();
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
      {
        id: "globex",
        backend: "mock",
        issuers: [{ ...issuers[0]!, requireTyp: true }],
        audience: "api://globex-sbm",
      },
    ],
  });
  expect(tenantAudience(base, tenants[0]!)).toBe(resourceUri(base, "acme"));
  expect(tenantAudience(base, tenants[1]!)).toBe("api://globex-sbm");
  expect(tenants[1]!.issuers[0]!.requireTyp).toBe(true);
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
  expect(() =>
    parseTenants({
      tenants: [{ id: "acme", backend: "mock", issuers, audience: "" }],
    }),
  ).toThrow(/audience/);
});

test("mock secrets take string static properties", () => {
  const [t] = parseTenants({
    tenants: [
      {
        id: "acme",
        backend: "mock",
        issuers,
        mockSecrets: [
          { name: "pw", value: "v", staticProperties: { "sbm:origin": "x" } },
        ],
      },
    ],
  });
  expect(t?.backend === "mock" && t.mockSecrets?.[0]?.staticProperties).toEqual(
    { "sbm:origin": "x" },
  );
  expect(() =>
    parseTenants({
      tenants: [
        {
          id: "acme",
          backend: "mock",
          issuers,
          mockSecrets: [{ name: "pw", value: "v", staticProperties: { a: 1 } }],
        },
      ],
    }),
  ).toThrow(/staticProperties/);
});

test("allowedClients is an optional, non-empty list of client ids", () => {
  const [t] = parseTenants({
    tenants: [
      { id: "acme", backend: "mock", issuers, allowedClients: ["agent-app"] },
    ],
  });
  expect(t?.allowedClients).toEqual(["agent-app"]);
  for (const allowedClients of [[], [""], "agent-app"]) {
    expect(() =>
      parseTenants({
        tenants: [{ id: "acme", backend: "mock", issuers, allowedClients }],
      }),
    ).toThrow(/allowedClients/);
  }
});
