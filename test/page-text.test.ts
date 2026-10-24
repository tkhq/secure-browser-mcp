import { afterAll, beforeAll, expect, test } from "bun:test";

import { RedactionRegistry } from "@turnkey/browser-secrets";
import type { Page } from "puppeteer-core";

import { LocalChromeHost } from "../src/browser/hosts.js";
import { capturePageText, MAX_SCANNED_TEXT } from "../src/browser/page-text.js";
import { captureSnapshot } from "../src/browser/snapshot.js";
import { BrowserSession } from "../src/browser/session.js";
import { findChrome } from "../src/runtime.js";

/** The snapshot's text summary: what it reads, its caps, and redaction. */

let session: BrowserSession;
let page: Page;

beforeAll(async () => {
  session = new BrowserSession(
    new LocalChromeHost({ executablePath: findChrome(), headless: true }),
  );
  page = await session.ensureStarted();
});

afterAll(async () => {
  await session.close();
});

test("reads visible headings and alert regions only", async () => {
  await page.setContent(`
    <h1>Pay   Northlake</h1>
    <p>Body text is left out.</p>
    <h2 style="display:none">Hidden</h2>
    <div role="alert">Your card was <b>declined</b>.</div>
    <div aria-live="polite"><p role="status">Nested once</p></div>
    <div aria-live="off">Not live</div>
    <input value="typed into a field" />
  `);
  expect(await capturePageText(page, new RedactionRegistry())).toEqual({
    headings: ["Pay Northlake"],
    alerts: ["Your card was declined.", "Nested once"],
  });
});

test("caps the number and the length of entries", async () => {
  const many = Array.from({ length: 30 }, (_, i) => `<h3>H${i}</h3>`).join("");
  await page.setContent(`${many}<h1>${"x".repeat(500)}</h1>`);
  const { headings } = await capturePageText(page, new RedactionRegistry());
  expect(headings).toHaveLength(20);
  await page.setContent(`<h1>${"x".repeat(500)}</h1>`);
  const [long] = (await capturePageText(page, new RedactionRegistry()))
    .headings;
  expect(long).toHaveLength(200);
  expect(long!.endsWith("…")).toBe(true);
});

test("scrubs a secret before the cut, so no part of it is left", async () => {
  const registry = new RedactionRegistry();
  registry.registerValue("4242424242424242", "card");
  // The number starts just before the cut, grouped as the page shows it.
  await page.setContent(
    `<div role="status">${"x".repeat(195)} 4242 4242 4242 4242 saved</div>`,
  );
  const [status] = (await capturePageText(page, registry)).alerts;
  expect(status).toHaveLength(200);
  expect(status).not.toContain("4242");
  expect(status!.slice(196)).toBe("[RE…");
});

test("scrubs a secret longer than the cut whole", async () => {
  const registry = new RedactionRegistry();
  const secret = `synthetic-${"s3cr3t".repeat(160)}`;
  registry.registerValue(secret, "long");
  await page.setContent(`<h1>${secret}</h1>`);
  const [heading] = (await capturePageText(page, registry)).headings;
  expect(heading).toBe("[REDACTED:long]");
});

test("leaves out an entry too long to scan", async () => {
  await page.setContent(
    `<h1>Short</h1><h2>${"x".repeat(MAX_SCANNED_TEXT + 1)}</h2>`,
  );
  const { headings } = await capturePageText(page, new RedactionRegistry());
  expect(headings).toEqual(["Short"]);
});

test("scrubs an element's text before the cut", async () => {
  const registry = new RedactionRegistry();
  registry.registerValue("4242424242424242", "card");
  // The number starts just before the 120-character cut.
  await page.setContent(
    `<button>${"x".repeat(110)} 4242 4242 4242 4242</button>`,
  );
  const snap = await captureSnapshot(session, registry);
  const button = snap.elements.find((e) => e.tag === "button")!;
  expect(button.text).toHaveLength(120);
  expect(button.text).not.toContain("4242");
  expect(button.text!.slice(111)).toBe("[REDACTE…");
});
