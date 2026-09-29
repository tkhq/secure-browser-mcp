import { describe, expect, test } from "bun:test";

import { BindingPolicy } from "../src/broker/binding.js";
import { parseBinding } from "../src/broker/mock-secrets.js";
import { BINDING_KEYS, type SecretRef } from "../src/broker/types.js";

const origin = "https://shop.example";
const fields = JSON.stringify({ number: "input[name=cardNumber]" });

describe("parseBinding", () => {
  test("no sbm:origin means no binding", () => {
    expect(parseBinding({})).toEqual({});
  });

  test("parses a full binding", () => {
    expect(
      parseBinding({
        [BINDING_KEYS.origin]: origin,
        [BINDING_KEYS.urlPattern]: "/checkout*",
        [BINDING_KEYS.fields]: fields,
      }),
    ).toEqual({
      binding: {
        origin,
        urlPattern: "/checkout*",
        fields: { number: "input[name=cardNumber]" },
      },
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
    const parsed = parseBinding(props);
    expect(parsed.binding).toBeUndefined();
    expect(parsed.bindingError).toBeString();
  });
});

describe("BindingPolicy", () => {
  test("refuses a secret with a malformed binding", async () => {
    const ref: SecretRef = {
      secretId: "s1",
      staticProperties: {},
      ...parseBinding({
        [BINDING_KEYS.origin]: origin,
        [BINDING_KEYS.fields]: "not json",
      }),
    };
    await expect(
      new BindingPolicy().assertAllowed(
        ref,
        { pageUrl: `${origin}/checkout`, elementUid: "e1" },
        { elementMatches: async () => true },
      ),
    ).rejects.toThrow("destination binding is invalid");
  });
});
