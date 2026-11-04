import { afterEach, describe, expect, test } from "bun:test";

import {
  dashboardActivityUrl,
  dashboardBaseFromEnv,
  dashboardCreateSecretUrl,
} from "../src/broker/turnkey-env.js";

const saved = {
  api: process.env["TURNKEY_API_BASE_URL"],
  override: process.env["SBM_DASHBOARD_URL"],
};
afterEach(() => {
  if (saved.api === undefined) delete process.env["TURNKEY_API_BASE_URL"];
  else process.env["TURNKEY_API_BASE_URL"] = saved.api;
  if (saved.override === undefined) delete process.env["SBM_DASHBOARD_URL"];
  else process.env["SBM_DASHBOARD_URL"] = saved.override;
});

describe("dashboard activity URL", () => {
  test("defaults to the production dashboard", () => {
    delete process.env["TURNKEY_API_BASE_URL"];
    delete process.env["SBM_DASHBOARD_URL"];
    expect(dashboardActivityUrl("01a0-abc")).toBe(
      "https://app.turnkey.com/dashboard/v2/activities/01a0-abc",
    );
  });
  test("maps engineering environments by name", () => {
    process.env["TURNKEY_API_BASE_URL"] = "https://api.dev.turnkey.engineering";
    expect(dashboardBaseFromEnv()).toBe(
      "https://app.dev.turnkey.engineering/dashboard/v2",
    );
  });
  test("honors SBM_DASHBOARD_URL and strips trailing slashes", () => {
    process.env["SBM_DASHBOARD_URL"] = "https://dash.example.test/";
    expect(dashboardActivityUrl("x")).toBe(
      "https://dash.example.test/activities/x",
    );
  });
  test("returns undefined for unknown hosts", () => {
    delete process.env["SBM_DASHBOARD_URL"];
    process.env["TURNKEY_API_BASE_URL"] = "http://localhost:9999";
    expect(dashboardActivityUrl("x")).toBeUndefined();
    expect(
      dashboardCreateSecretUrl("org", "password", {
        "sbm:origin": "https://example.com",
        "sbm:selector": "#password",
      }),
    ).toBeUndefined();
  });

  test("encodes draft metadata without letting it change the dashboard destination", () => {
    process.env["SBM_DASHBOARD_URL"] =
      "https://dash.example.test/dashboard/v2/";
    const properties = {
      "sbm:origin": "https://shop.example",
      "sbm:selector": 'input[name="password&redirect=https://evil.example"]',
    };
    const url = new URL(
      dashboardCreateSecretUrl("org-a", "card & password #1", properties)!,
    );
    expect(url.origin).toBe("https://dash.example.test");
    expect(url.pathname).toBe("/dashboard/v2/secrets");
    expect(JSON.parse(url.searchParams.get("name")!)).toBe(
      "card & password #1",
    );
    expect(url.searchParams.get("organizationId")).toBe("org-a");
    expect(JSON.parse(url.searchParams.get("staticProperties")!)).toEqual(
      Object.entries(properties).map(([key, value]) => ({ key, value })),
    );
    expect(url.searchParams.has("redirect")).toBe(false);
    expect(url.hash).toBe("");
    expect(() =>
      dashboardCreateSecretUrl("org", "card", {
        "sbm:selector": "x".repeat(8192),
      }),
    ).toThrow("too large");
  });

  test("preserves JSON-looking names through the dashboard search parser", () => {
    process.env["SBM_DASHBOARD_URL"] = "https://dash.example.test/dashboard/v2";
    for (const name of [
      "123.0",
      "true",
      "null",
      '{"label":"card"}',
      '"login"',
    ]) {
      const url = new URL(dashboardCreateSecretUrl("org-a", name, {})!);
      expect(JSON.parse(url.searchParams.get("name")!)).toBe(name);
    }
  });
});
