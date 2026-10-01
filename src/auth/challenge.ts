/**
 * What the hosted broker tells an OAuth client: Protected Resource Metadata
 * (RFC 9728) and the WWW-Authenticate challenges (RFC 6750 §3) that point
 * at it, as MCP authorization requires.
 */
import { SCOPES } from "./scopes.js";
import { resourceUri, type TenantConfig } from "./tenants.js";

export function protectedResourceMetadata(
  publicUrl: string,
  tenant: TenantConfig,
) {
  return {
    resource: resourceUri(publicUrl, tenant.id),
    authorization_servers:
      tenant.authorizationServers ?? tenant.issuers.map((i) => i.issuer),
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: `secure-browser-mcp (${tenant.id})`,
  };
}

/** RFC 6750 auth-param values are quoted strings; keep them printable and
 * free of quotes and backslashes. */
function quote(value: string): string {
  return `"${value.replace(/[^\x20-\x7e]|["\\]/g, "")}"`;
}

export type Challenge = {
  /** Omitted when the request carried no token (RFC 6750 §3.1). */
  error?: "invalid_token" | "insufficient_scope";
  description?: string;
  /** Scopes the client should request. */
  scopes: readonly string[];
  resourceMetadata: string;
};

export function wwwAuthenticate(c: Challenge): string {
  const params: [string, string][] = [];
  if (c.error) params.push(["error", c.error]);
  if (c.description) params.push(["error_description", c.description]);
  params.push(["scope", c.scopes.join(" ")]);
  params.push(["resource_metadata", c.resourceMetadata]);
  return `Bearer ${params.map(([k, v]) => `${k}=${quote(v)}`).join(", ")}`;
}
