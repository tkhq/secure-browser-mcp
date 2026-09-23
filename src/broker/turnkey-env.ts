import { Turnkey, type TurnkeyApiClient } from "@turnkey/sdk-server";

/**
 * Build a Turnkey API client from TURNKEY_* env vars, or undefined when the
 * credentials are not configured. Shared by the server entrypoint and the
 * scripts/ helpers.
 */
export function turnkeyClientFromEnv(): TurnkeyApiClient | undefined {
  const apiPrivateKey = process.env["TURNKEY_API_PRIVATE_KEY"];
  const apiPublicKey = process.env["TURNKEY_API_PUBLIC_KEY"];
  const defaultOrganizationId = process.env["TURNKEY_ORGANIZATION_ID"];
  if (!apiPrivateKey || !apiPublicKey || !defaultOrganizationId) {
    return undefined;
  }
  return new Turnkey({
    apiBaseUrl:
      process.env["TURNKEY_API_BASE_URL"] ?? "https://api.turnkey.com",
    apiPrivateKey,
    apiPublicKey,
    defaultOrganizationId,
  }).apiClient();
}

/**
 * Dashboard page for a Turnkey activity, so approvers can be sent a link
 * instead of a bare id. Derived from TURNKEY_API_BASE_URL (api.turnkey.com →
 * app.turnkey.com, api.<env>.turnkey.engineering → app.<env>.turnkey.engineering);
 * SBM_DASHBOARD_URL overrides the base. Undefined when the host is unknown —
 * callers then fall back to the activity id alone.
 */
export function dashboardActivityUrl(activityId: string): string | undefined {
  const base = dashboardBaseFromEnv();
  if (!base) return undefined;
  return `${base}/activities/${encodeURIComponent(activityId)}`;
}

export function dashboardBaseFromEnv(): string | undefined {
  const override = process.env["SBM_DASHBOARD_URL"];
  if (override) return override.replace(/\/+$/, "");
  const api = process.env["TURNKEY_API_BASE_URL"] ?? "https://api.turnkey.com";
  let host: string;
  try {
    host = new URL(api).host;
  } catch {
    return undefined;
  }
  if (host === "api.turnkey.com") return "https://app.turnkey.com/dashboard/v2";
  const m = /^api\.([a-z0-9-]+)\.turnkey\.engineering$/.exec(host);
  if (m) return `https://app.${m[1]}.turnkey.engineering/dashboard/v2`;
  return undefined;
}
