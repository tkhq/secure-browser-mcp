/**
 * Tracks which secret material is "live" — exported and possibly present in
 * the page, network requests, or console output — so every tool result can
 * be scrubbed before it reaches the agent.
 *
 * Two registries:
 *  - plaintext scrub-set: values to value-scan out of any output
 *    (backstop; catches secrets echoed via network bodies, console, etc.)
 *  - tagged fields: element uids whose values must be structurally elided
 *    from snapshots (primary; does not depend on spotting the value)
 *
 * The value-scan also catches reformatted copies. Pages normalize what they
 * receive ("4242424242424242" renders as "4242 4242 4242 4242"), so values
 * long enough to match safely are also compared with separators removed and
 * case folded. A hostile destination can always encode a value past any
 * scanner; that is the out-of-scope "target site" case in THREAT-MODEL.md.
 */

/** Characters formatters insert between groups. */
const SEPARATOR = /[\s\-./_]/;

/**
 * Shortest value matched loosely. Shorter values (a CVC, an expiry) would
 * redact unrelated digits all over the output; they keep exact matching.
 */
export const MIN_LOOSE_MATCH_LENGTH = 8;

type LiveValue = { secretId: string; loose: string | undefined };

type Span = { start: number; end: number; secretId: string };

export class RedactionRegistry {
  private readonly plaintexts = new Map<string, LiveValue>(); // value → info
  private readonly taggedFields = new Map<string, string>(); // elementUid → secretId

  /** Register a live plaintext the moment it is exported into broker memory. */
  trackValue(plaintext: string, secretId: string): void {
    const loose = normalize(plaintext).text;
    this.plaintexts.set(plaintext, {
      secretId,
      loose: loose.length >= MIN_LOOSE_MATCH_LENGTH ? loose : undefined,
    });
  }

  /** Register a field that received a secret, keyed by snapshot element uid. */
  trackField(elementUid: string, secretId: string): void {
    this.taggedFields.set(elementUid, secretId);
  }

  isTaggedField(elementUid: string): boolean {
    return this.taggedFields.has(elementUid);
  }

  /** The secretId of the first live plaintext in `text`, if any. */
  findSecret(text: string): string | undefined {
    return this.spans(text)[0]?.secretId;
  }

  /** Value-scan: replace every occurrence of a live plaintext in `text`. */
  scrubText(text: string): string {
    const spans = this.spans(text);
    if (spans.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const span of spans) {
      out += text.slice(cursor, span.start) + `[REDACTED:${span.secretId}]`;
      cursor = span.end;
    }
    return out + text.slice(cursor);
  }

  /** Every match in `text`, sorted, with overlapping matches merged. */
  private spans(text: string): Span[] {
    const found: Span[] = [];
    let normalized: ReturnType<typeof normalize> | undefined;
    for (const [value, { secretId, loose }] of this.plaintexts) {
      if (value.length === 0) continue;
      for (let i = text.indexOf(value); i !== -1;) {
        found.push({ start: i, end: i + value.length, secretId });
        i = text.indexOf(value, i + value.length);
      }
      if (loose === undefined) continue;
      normalized ??= normalize(text);
      const { text: haystack, offsets } = normalized;
      for (let i = haystack.indexOf(loose); i !== -1;) {
        const last = i + loose.length - 1;
        found.push({ start: offsets[i]!, end: offsets[last]! + 1, secretId });
        i = haystack.indexOf(loose, i + loose.length);
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Span[] = [];
    for (const span of found) {
      const prev = merged[merged.length - 1];
      if (prev && span.start < prev.end) {
        prev.end = Math.max(prev.end, span.end);
      } else {
        merged.push({ ...span });
      }
    }
    return merged;
  }
}

/**
 * Drop separators and fold case, one UTF-16 unit at a time, recording where
 * each kept unit came from so a match maps back to a span of the original.
 */
function normalize(text: string): { text: string; offsets: number[] } {
  let out = "";
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (SEPARATOR.test(ch)) continue;
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
    offsets.push(i);
  }
  return { text: out, offsets };
}
