import type { RedactionRegistry } from "@turnkey/browser-secrets";
import type { Page } from "puppeteer-core";

/**
 * A short text summary of the page, so an agent can read a result or an
 * error ("Payment complete", "Your card was declined") that is not an
 * interactive element. Only headings and alert, status and live regions,
 * capped in count and length: not the page's full text.
 */
export type PageText = {
  headings: string[];
  alerts: string[];
};

const HEADINGS = "h1, h2, h3, h4, h5, h6, [role=heading]";
const ALERTS = [
  "[role=alert]",
  "[role=alertdialog]",
  "[role=status]",
  "[aria-live]:not([aria-live=off])",
  "output",
].join(", ");

const MAX_HEADINGS = 20;
const MAX_ALERTS = 10;
/** Characters per entry the agent sees. */
const MAX_ENTRY = 200;
/**
 * The longest text read from the page. Text is scanned whole and cut only
 * after the scan: a cut first could leave the start of a secret that the
 * scan no longer recognizes. Longer text is left out, not cut.
 */
export const MAX_SCANNED_TEXT = 16_384;

/**
 * Replaces the secrets in `text`, then cuts it to `max` characters. The
 * text must be complete, not already cut: a part of a secret does not
 * match the scan.
 */
export function scrubThenCut(
  registry: RedactionRegistry,
  text: string,
  max: number,
): string {
  const scrubbed = registry.scrubText(text);
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}

/**
 * Reads headings and alert regions of the top-level document, in document
 * order. Each entry goes through the value scan before it is cut to size,
 * and an entry too long to scan whole is left out.
 * innerText leaves out form field values, so a filled field's value never
 * gets here; a secret the page shows as text is replaced with its marker.
 */
export async function capturePageText(
  page: Page,
  registry: RedactionRegistry,
): Promise<PageText> {
  const raw = await page.evaluate(
    (headings, alerts, maxHeadings, maxAlerts, maxScanned) => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const read = (selector: string, max: number) => {
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll(selector))) {
          if (out.length >= max) break;
          // A region inside another one is already in its text.
          if (el.parentElement?.closest(selector)) continue;
          if (!visible(el)) continue;
          const text = (el as HTMLElement).innerText
            ?.replace(/\s+/g, " ")
            .trim();
          if (text && text.length <= maxScanned) out.push(text);
        }
        return out;
      };
      return {
        headings: read(headings, maxHeadings),
        alerts: read(alerts, maxAlerts),
      };
    },
    HEADINGS,
    ALERTS,
    MAX_HEADINGS,
    MAX_ALERTS,
    MAX_SCANNED_TEXT,
  );
  const clean = (text: string) => scrubThenCut(registry, text, MAX_ENTRY);
  return {
    headings: raw.headings.map(clean),
    alerts: raw.alerts.map(clean),
  };
}
