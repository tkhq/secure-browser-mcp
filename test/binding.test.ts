import { describe, expect, test } from "bun:test";

import { createSecretRef, DENY_REASONS } from "@turnkey/browser-secrets";

import { MockSecretsClient } from "../src/broker/mock-secrets.js";
import { BINDING_KEYS } from "../src/broker/types.js";
import { FillDeniedError } from "../src/tools/fill-common.js";

const origin = "https://shop.example";
const fields = JSON.stringify({ number: "input[name=cardNumber]" });

/**
 * Bindings are parsed by @turnkey/browser-secrets. These cases pin the
 * secrets the broker accepted and refused before the move, so a package
 * change that loosens or breaks an existing secret fails here.
 */
describe("binding parsing", () => {
  const ref = (staticProperties: Record<string, string>) =>
    createSecretRef({ secretId: "s1", staticProperties });

  test("no sbm:origin means no binding", () => {
    const parsed = ref({ [BINDING_KEYS.selector]: "input" });
    expect(parsed.binding).toBeUndefined();
    expect(parsed.bindingError).toBeUndefined();
  });

  test("parses a full binding", () => {
    expect(
      ref({
        [BINDING_KEYS.origin]: origin,
        [BINDING_KEYS.urlPattern]: "/checkout*",
        [BINDING_KEYS.fields]: fields,
      }).binding,
    ).toEqual({
      origin,
      urlPattern: "/checkout*",
      fields: { number: "input[name=cardNumber]" },
    });
  });

  test.each([
    ["origin is not a URL", { [BINDING_KEYS.origin]: "shop.example" }],
    ["origin has a path", { [BINDING_KEYS.origin]: `${origin}/login` }],
    ["origin has a trailing slash", { [BINDING_KEYS.origin]: `${origin}/` }],
    [
      "fields is not JSON",
      { [BINDING_KEYS.origin]: origin, [BINDING_KEYS.fields]: "{number:" },
    ],
    [
      "fields is an array",
      { [BINDING_KEYS.origin]: origin, [BINDING_KEYS.fields]: "[]" },
    ],
    [
      "fields is empty",
      { [BINDING_KEYS.origin]: origin, [BINDING_KEYS.fields]: "{}" },
    ],
    [
      "a field selector is not a string",
      { [BINDING_KEYS.origin]: origin, [BINDING_KEYS.fields]: '{"cvc":1}' },
    ],
    [
      "selector is blank",
      { [BINDING_KEYS.origin]: origin, [BINDING_KEYS.selector]: " " },
    ],
  ])("rejects a binding whose %s", (_, props) => {
    const parsed = ref(props);
    expect(parsed.binding).toBeUndefined();
    expect(parsed.bindingError).toBeString();
  });

  test("the mock seed secrets all bind", async () => {
    for (const r of await new MockSecretsClient().listRefs()) {
      expect(r.bindingError).toBeUndefined();
      expect(r.binding?.origin).toBeString();
    }
  });
});

describe("FillDeniedError", () => {
  const card = { secretId: "s1", name: "demo-card" };

  test.each([...DENY_REASONS, "destination_changed" as const])(
    "%s names the reason and holds no URL",
    (reason) => {
      const message = new FillDeniedError(reason, card, "e12").message;
      expect(message).toStartWith('Refusing to fill "demo-card": ');
      expect(message).toEndWith(`(${reason}, element e12)`);
      expect(message).not.toMatch(/https?:/);
    },
  );

  test("falls back to the secret ID without a name", () => {
    expect(
      new FillDeniedError("unbound_secret", { secretId: "s1" }).message,
    ).toStartWith('Refusing to fill "s1": ');
  });
});
