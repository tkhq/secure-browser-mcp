import { describe, expect, test } from "bun:test";

import type { TurnkeyApiClient } from "@turnkey/sdk-server";

import { TurnkeySecretsClient } from "../src/broker/turnkey-secrets.js";
import { selectRefs } from "../src/tools/list-secret-refs.js";
import type { SecretRef } from "../src/broker/types.js";

type Page = { paginationOptions?: { limit?: string; after?: string } };

function fakeClient(total: number) {
  const ids = Array.from(
    { length: total },
    (_, i) => `s${String(i).padStart(4, "0")}`,
  );
  const calls: Page[] = [];
  const client = {
    getSecrets: async (params: Page = {}) => {
      calls.push(params);
      const limit = Number(params.paginationOptions?.limit ?? "10");
      const after = params.paginationOptions?.after;
      const start = after ? ids.indexOf(after) + 1 : 0;
      return ids.slice(start, start + limit).map((secretId, i) => ({
        secretId,
        name: `secret-${secretId}`,
        staticProperties:
          i % 2 === 0 ? { "sbm:origin": "https://a.example" } : {},
        createdAtUnixMs: "0",
      }));
    },
  };
  return { client: client as unknown as TurnkeyApiClient, calls };
}

describe("TurnkeySecretsClient.listRefs", () => {
  test("walks every page instead of the API's 10-item default", async () => {
    const { client, calls } = fakeClient(250);
    const refs = await new TurnkeySecretsClient(client).listRefs();
    expect(refs).toHaveLength(250);
    expect(new Set(refs.map((r) => r.secretId)).size).toBe(250);
    expect(calls.map((c) => c.paginationOptions?.limit)).toEqual([
      "100",
      "100",
      "100",
    ]);
    expect(calls.map((c) => c.paginationOptions?.after)).toEqual([
      undefined,
      "s0099",
      "s0199",
    ]);
  });

  test("stops after a short page without an extra request", async () => {
    const { client, calls } = fakeClient(7);
    const refs = await new TurnkeySecretsClient(client).listRefs();
    expect(refs).toHaveLength(7);
    expect(calls).toHaveLength(1);
  });

  test("an exact multiple of the page size costs one empty page", async () => {
    const { client, calls } = fakeClient(100);
    expect(await new TurnkeySecretsClient(client).listRefs()).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });
});

describe("selectRefs", () => {
  const refs: SecretRef[] = [
    {
      secretId: "1",
      name: "stripe-card",
      staticProperties: {},
      binding: { origin: "https://buy.stripe.com" },
    },
    {
      secretId: "2",
      name: "bank-login",
      staticProperties: {},
      binding: { origin: "https://portal.example.com", urlPattern: "/login*" },
    },
    {
      secretId: "3",
      name: "agent/OPENROUTER_API_KEY",
      staticProperties: { consensus: "unilateral" },
    },
  ];

  test("hides unbound secrets by default", () => {
    expect(selectRefs(refs, {}).map((r) => r.secretId)).toEqual(["1", "2"]);
  });

  test("include_unbound shows everything", () => {
    expect(selectRefs(refs, { include_unbound: true })).toHaveLength(3);
  });

  test("origin narrows to the page being filled, ignoring trailing slash and path", () => {
    expect(
      selectRefs(refs, { origin: "https://buy.stripe.com/" }).map(
        (r) => r.name,
      ),
    ).toEqual(["stripe-card"]);
    expect(
      selectRefs(refs, { origin: "https://portal.example.com/login?x=1" }).map(
        (r) => r.name,
      ),
    ).toEqual(["bank-login"]);
    expect(selectRefs(refs, { origin: "https://other.example" })).toEqual([]);
  });
});
