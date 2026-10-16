import { expect, test } from "bun:test";

import { RedactionRegistry } from "@turnkey/browser-secrets";

/**
 * The broker's redaction guarantees, run against the @turnkey/browser-secrets
 * registry that now provides them. These cases came with the broker's own
 * registry; keeping them here fails a package change that weakens them.
 */

const registry = () => {
  const r = new RedactionRegistry();
  r.registerValue("4242424242424242", "card");
  r.registerValue("123", "cvc");
  return r;
};

test("scrubs exact matches", () => {
  expect(registry().scrubText("n=4242424242424242")).toBe("n=[REDACTED:card]");
});

test("does not text-scan values shorter than four characters", () => {
  // The broker's own registry scanned these exactly. browser-secrets skips
  // them: they match unrelated text and are cheap to confirm by guessing.
  // A filled CVC field is still redacted by its registered target.
  const r = new RedactionRegistry();
  expect(r.registerValues([{ value: "123", secretId: "cvc" }])).toEqual([
    "cvc",
  ]);
  expect(r.scrubText("c=123")).toBe("c=123");
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
  expect(registry().findMatches(text)).toEqual([
    { start: 0, end: text.length, secretIds: ["card"] },
  ]);
});

test("does not stitch digits across wide gaps", () => {
  const text = "4242 then later 4242 and 4242 and finally 4242";
  expect(registry().scrubText(text)).toBe(text);
});

test("strips punctuation from long non-digit values", () => {
  const r = new RedactionRegistry();
  r.registerValue("sk_live_abc123def456", "key");
  expect(r.scrubText("key: SK-LIVE:ABC123,DEF456 ok")).toBe(
    "key: [REDACTED:key] ok",
  );
});

test("folds case for long values", () => {
  const r = new RedactionRegistry();
  r.registerValue("gb82west12345698765432", "iban");
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

test("findSecretIds reports formatted copies", () => {
  const r = registry();
  expect(r.findSecretIds("4242 4242 4242 4242")).toEqual(["card"]);
  expect(r.findSecretIds("nothing here")).toEqual([]);
});

test("target tags are document-scoped", () => {
  const r = new RedactionRegistry();
  const target = {
    browserSessionId: "b",
    tabId: "t",
    frameId: "f",
    documentId: "d1",
    elementId: "e1",
  };
  r.registerTarget(target, "card");
  expect(r.isRegisteredTarget(target)).toBe(true);
  expect(r.isRegisteredTarget({ ...target, documentId: "d2" })).toBe(false);
});
