/**
 * Tenant configuration for the hosted broker (docs/HOSTED.md, "Tenants").
 *
 * The file named by SBM_TENANTS is deployment config, never part of this
 * repo. It names, for each tenant, which Turnkey organization the tenant's
 * fills come from, where the broker finds that organization's API key, and
 * which authorization servers may issue tokens for the tenant. The file
 * holds references to keys, not keys.
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

/** Tenant ids appear in URL paths and state directory names. */
const TENANT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** HTTPS, or HTTP to a loopback host for local development and tests. */
function secureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

const url = z
  .string()
  .refine(secureUrl, "must be an https URL (http only for localhost)");

const issuerSchema = z
  .object({
    /** Exact `iss` value of the authorization server's tokens. */
    issuer: url,
    /** Where that server publishes its signing keys. */
    jwksUri: url,
  })
  .strict();

/**
 * A Turnkey API key, by reference: either two environment variables or a
 * JSON file (`{"publicKey": "...", "privateKey": "..."}`) in a secrets
 * mount.
 */
const apiKeySchema = z.union([
  z
    .object({
      publicKeyEnv: z.string().min(1),
      privateKeyEnv: z.string().min(1),
    })
    .strict(),
  z.object({ path: z.string().min(1) }).strict(),
]);

const mockSecretSchema = z
  .object({
    name: z.string().min(1),
    value: z.string(),
    staticProperties: z.record(z.string()),
  })
  .strict();

const common = {
  id: z.string().regex(TENANT_ID, "lowercase letters, digits, and dashes"),
  issuers: z.array(issuerSchema).min(1),
  /** Advertised in Protected Resource Metadata. Defaults to the issuers. */
  authorizationServers: z.array(url).min(1).optional(),
};

const tenantSchema = z.discriminatedUnion("backend", [
  z
    .object({
      ...common,
      backend: z.literal("turnkey"),
      /** The tenant's Turnkey (sub-)organization. */
      organizationId: z.string().min(1),
      apiKey: apiKeySchema,
    })
    .strict(),
  // Development and tests only: in-memory secrets, seeded per tenant.
  z
    .object({
      ...common,
      backend: z.literal("mock"),
      mockSecrets: z.array(mockSecretSchema).optional(),
    })
    .strict(),
]);

const fileSchema = z
  .object({
    tenants: z
      .array(
        // `backend` defaults to turnkey; mock must be asked for by name.
        z.preprocess(
          (t) =>
            t && typeof t === "object" && !("backend" in t)
              ? { ...t, backend: "turnkey" }
              : t,
          tenantSchema,
        ),
      )
      .min(1),
  })
  .strict();

export type TenantConfig = z.infer<typeof tenantSchema>;
export type TrustedIssuer = z.infer<typeof issuerSchema>;
export type MockSecretSeed = z.infer<typeof mockSecretSchema>;

/** Parse and check a tenants document. Throws with every problem found. */
export function parseTenants(raw: unknown): TenantConfig[] {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid tenant config: ${problems}`);
  }
  const tenants = parsed.data.tenants as TenantConfig[];
  const seen = new Set<string>();
  for (const t of tenants) {
    if (seen.has(t.id)) throw new Error(`Duplicate tenant id: ${t.id}`);
    seen.add(t.id);
  }
  return tenants;
}

export function loadTenants(path: string): TenantConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read SBM_TENANTS (${path}): ${reason}`);
  }
  return parseTenants(raw);
}

/** Resolve a tenant's Turnkey API key reference. */
export function resolveApiKey(
  tenant: Extract<TenantConfig, { backend: "turnkey" }>,
): { apiPublicKey: string; apiPrivateKey: string } {
  const ref = tenant.apiKey;
  if ("path" in ref) {
    let key: { publicKey?: unknown; privateKey?: unknown };
    try {
      key = JSON.parse(readFileSync(ref.path, "utf8"));
    } catch {
      throw new Error(`Tenant ${tenant.id}: cannot read API key file`);
    }
    if (typeof key.publicKey !== "string" || typeof key.privateKey !== "string")
      throw new Error(
        `Tenant ${tenant.id}: API key file needs publicKey and privateKey`,
      );
    return { apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey };
  }
  const apiPublicKey = process.env[ref.publicKeyEnv];
  const apiPrivateKey = process.env[ref.privateKeyEnv];
  if (!apiPublicKey || !apiPrivateKey) {
    throw new Error(
      `Tenant ${tenant.id}: set ${ref.publicKeyEnv} and ${ref.privateKeyEnv}`,
    );
  }
  return { apiPublicKey, apiPrivateKey };
}

/**
 * SBM_PUBLIC_URL: the origin clients reach the broker at, e.g.
 * https://sbm.example.com. Tenant resource URIs, and so token audiences,
 * are built from it, so it must not come from request headers.
 */
export function parsePublicUrl(value: string): string {
  const parsed = secureUrl(value) ? new URL(value) : undefined;
  if (!parsed || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(
      "SBM_PUBLIC_URL must be an https origin, e.g. https://sbm.example.com",
    );
  }
  return parsed.origin;
}

/** The tenant's MCP endpoint path. */
export function tenantPath(id: string): string {
  return `/t/${id}/mcp`;
}

/** RFC 8707 resource indicator for the tenant: the token audience. */
export function resourceUri(publicUrl: string, id: string): string {
  return `${publicUrl}${tenantPath(id)}`;
}

/** RFC 9728 §3.1: the well-known path inserted before the resource path. */
export function metadataPath(id: string): string {
  return `/.well-known/oauth-protected-resource${tenantPath(id)}`;
}

export function metadataUri(publicUrl: string, id: string): string {
  return `${publicUrl}${metadataPath(id)}`;
}
