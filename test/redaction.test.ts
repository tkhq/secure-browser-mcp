import { expect, test } from "bun:test";

import { RedactionRegistry } from "../src/redaction/registry.js";

const registry = () => {
  const r = new RedactionRegistry();
  r.trackValue("4242424242424242", "card");
  r.trackValue("123", "cvc");
  return r;
};

test("scrubs exact matches", () => {
  expect(registry().scrubText("n=4242424242424242&c=123")).toBe(
    "n=[REDACTED:card]&c=[REDACTED:cvc]",
  );
});

test("scrubs separator-formatted copies of long values", () => {
  const r = registry();
  for (const formatted of [
    "4242 4242 4242 4242",
    "4242-4242-4242-4242",
    "4242 4242 4242 4242",
  ]) {
    expect(r.scrubText(`card ${formatted}.`)).toBe("card [REDACTED:card].");
  }
});

test("scrubs copies grouped with any separator", () => {
  const r = registry();
  for (const formatted of [
    "4242,4242,4242,4242",
    "4242'4242'4242'4242",
    "4242·4242·4242·4242",
    "4242:4242:4242:4242",
    "4242x4242x4242x4242",
    "4242\u200b4242\u200b4242\u200b4242",
    "4242 , 4242 , 4242 , 4242",
    "４２４２４２４２４２４２４２４２",
  ]) {
    expect(r.scrubText(`card ${formatted}.`)).toBe("card [REDACTED:card].");
  }
});

test("scrubs URL-encoded and other-script copies", () => {
  const r = registry();
  for (const formatted of [
    "4242%204242%204242%204242",
    "4242%2C%204242%2C%204242%2C%204242",
    "%34%32%34%32%34%32%34%32%34%32%34%32%34%32%34%32",
    "٤٢٤٢ ٤٢٤٢ ٤٢٤٢ ٤٢٤٢",
    "४२४२-४२४२-४२४२-४२४२",
  ]) {
    expect(r.scrubText(`card ${formatted}.`)).toBe("card [REDACTED:card].");
  }
});

test("returns match spans for callers that map them back", () => {
  const text = "4242 4242 | 4242 4242";
  expect(registry().matches(text)).toEqual([
    { start: 0, end: text.length, secretId: "card" },
  ]);
});

test("does not stitch digits across wide gaps", () => {
  const text = "4242 then later 4242 and 4242 and finally 4242";
  expect(registry().scrubText(text)).toBe(text);
});

test("strips punctuation from long non-digit values", () => {
  const r = new RedactionRegistry();
  r.trackValue("sk_live_abc123def456", "key");
  expect(r.scrubText("key: SK-LIVE:ABC123,DEF456 ok")).toBe(
    "key: [REDACTED:key] ok",
  );
});

test("folds case for long values", () => {
  const r = new RedactionRegistry();
  r.trackValue("gb82west12345698765432", "iban");
  expect(r.scrubText("IBAN GB82 WEST 1234 5698 7654 32 ok")).toBe(
    "IBAN [REDACTED:iban] ok",
  );
});

test("matches short values exactly only", () => {
  expect(registry().scrubText("1 2 3 and 1-2-3")).toBe("1 2 3 and 1-2-3");
});

test("leaves partial copies alone", () => {
  expect(registry().scrubText("card ending 4242")).toBe("card ending 4242");
});

test("findSecret reports formatted copies", () => {
  const r = registry();
  expect(r.findSecret("4242 4242 4242 4242")).toBe("card");
  expect(r.findSecret("nothing here")).toBeUndefined();
});
