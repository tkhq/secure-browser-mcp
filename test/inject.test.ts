import { expect, test } from "bun:test";

import { valueMatches } from "../src/browser/inject.js";

/** How a fill's read-back decides that a field holds the secret. */

test("matches the exact value", () => {
  expect(valueMatches("synthetic-password!", "synthetic-password!", true)).toBe(
    true,
  );
  expect(valueMatches("4242424242424242", "4242424242424242", false)).toBe(
    true,
  );
});

test("a password the page changed does not match", () => {
  // The page stripped the punctuation: a different password.
  expect(valueMatches("synthetic-password!", "syntheticpassword", true)).toBe(
    false,
  );
  // Not even in a field that is not a password input.
  expect(valueMatches("synthetic-password!", "syntheticpassword", false)).toBe(
    false,
  );
  expect(valueMatches("Pässword1", "Pässword1", false)).toBe(false);
});

test("a number the page grouped matches", () => {
  expect(valueMatches("4242424242424242", "4242 4242 4242 4242", false)).toBe(
    true,
  );
  expect(valueMatches("4242424242424242", "4242-4242-4242-4242", false)).toBe(
    true,
  );
  expect(valueMatches("1228", "12/28", false)).toBe(true);
  expect(valueMatches("4242 4242 4242 4242", "4242424242424242", false)).toBe(
    true,
  );
});

test("grouping tolerance has limits", () => {
  // Not in a password field.
  expect(valueMatches("123456", "123 456", true)).toBe(false);
  // Only separators may be added, not other characters.
  expect(valueMatches("4242424242424242", "4242a4242b4242c4242", false)).toBe(
    false,
  );
  // Digits that differ do not match.
  expect(valueMatches("4242424242424242", "4242 4242 4242 4241", false)).toBe(
    false,
  );
  expect(valueMatches("", "", false)).toBe(true);
  expect(valueMatches("", " ", false)).toBe(false);
});
