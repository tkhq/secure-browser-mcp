import { afterEach, describe, expect, test } from "bun:test";

import {
  dashboardActivityUrl,
  dashboardBaseFromEnv,
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
  });
});
