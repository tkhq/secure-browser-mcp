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
