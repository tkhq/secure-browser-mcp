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
 * long enough to match safely are also compared on their letters and digits
 * only, case folded and NFKC-normalized. Values made only of digits compare
 * on digits only, so letter separators ("4242x4242") match too. Any
 * separator counts, but each gap between kept characters is capped so a
 * match cannot stitch together digits from unrelated text. A hostile
 * destination can always encode a value past any scanner; that is the
 * out-of-scope "target site" case in THREAT-MODEL.md.
 */

const ALNUM = /[\p{L}\p{N}]/u;
const DIGIT = /\p{Nd}/u;

/** Most separator characters allowed between two kept characters of a match. */
const MAX_GAP = 3;

/**
 * Shortest value matched loosely. Shorter values (a CVC, an expiry) would
 * redact unrelated digits all over the output; they keep exact matching.
 */
export const MIN_LOOSE_MATCH_LENGTH = 8;

type Loose = { text: string; keep: RegExp };

type LiveValue = { secretId: string; loose: Loose | undefined };

export type Span = { start: number; end: number; secretId: string };

export class RedactionRegistry {
  private readonly plaintexts = new Map<string, LiveValue>(); // value → info
  private readonly taggedFields = new Map<string, string>(); // elementUid → secretId

  /** Register a live plaintext the moment it is exported into broker memory. */
  trackValue(plaintext: string, secretId: string): void {
    const text = normalize(plaintext, ALNUM).text;
    const keep = [...text].every((ch) => DIGIT.test(ch)) ? DIGIT : ALNUM;
    this.plaintexts.set(plaintext, {
      secretId,
      loose: text.length >= MIN_LOOSE_MATCH_LENGTH ? { text, keep } : undefined,
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

  /** Every live plaintext in `text`, as sorted, non-overlapping spans. */
  matches(text: string): Span[] {
    return this.spans(text);
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
    const normalized = new Map<RegExp, ReturnType<typeof normalize>>();
    for (const [value, { secretId, loose }] of this.plaintexts) {
      if (value.length === 0) continue;
      for (let i = text.indexOf(value); i !== -1;) {
        found.push({ start: i, end: i + value.length, secretId });
        i = text.indexOf(value, i + value.length);
      }
      if (loose === undefined) continue;
      let haystack = normalized.get(loose.keep);
      if (!haystack) {
        haystack = normalize(text, loose.keep);
        normalized.set(loose.keep, haystack);
      }
      const { text: hay, starts, ends, gaps } = haystack;
      const needle = loose.text;
      for (let i = hay.indexOf(needle); i !== -1;) {
        const last = i + needle.length - 1;
        if (!withinGap(gaps, i, last)) {
          i = hay.indexOf(needle, i + 1);
          continue;
        }
        found.push({ start: starts[i]!, end: ends[last]!, secretId });
        i = hay.indexOf(needle, i + needle.length);
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

/** Whether no gap between kept characters `first`..`last` exceeds MAX_GAP. */
function withinGap(gaps: number[], first: number, last: number): boolean {
  for (let k = first + 1; k <= last; k++) {
    if (gaps[k]! > MAX_GAP) return false;
  }
  return true;
}

const PERCENT_ESCAPE = /^%[0-9a-f]{2}$/i;

/**
 * Keep only characters matching `keep`, NFKC-normalized, case folded and with
 * decimal digits read as 0-9, one code point (or percent escape) at a time.
 * Records the span of the original each kept character came from, so a match
 * maps back to the original text, and how many characters were dropped
 * before it.
 */
function normalize(
  text: string,
  keep: RegExp,
): { text: string; starts: number[]; ends: number[]; gaps: number[] } {
  let out = "";
  const starts: number[] = [];
  const ends: number[] = [];
  const gaps: number[] = [];
  let gap = 0;
  let i = 0;
  while (i < text.length) {
    let unit = String.fromCodePoint(text.codePointAt(i)!);
    let width = unit.length;
    const escape = text.slice(i, i + 3);
    if (PERCENT_ESCAPE.test(escape)) {
      const byte = parseInt(escape.slice(1), 16);
      // Multi-byte UTF-8 escapes stay separators: formatters emit ASCII digits.
      unit = byte < 0x80 ? String.fromCharCode(byte) : "%";
      width = 3;
    }
    for (const ch of unit.normalize("NFKC").toLowerCase()) {
      if (!keep.test(ch)) {
        gap++;
        continue;
      }
      out += DIGIT.test(ch) ? digitValue(ch) : ch;
      starts.push(i);
      ends.push(i + width);
      gaps.push(gap);
      gap = 0;
    }
    i += width;
  }
  return { text: out, starts, ends, gaps };
}

/**
 * The 0-9 value of a decimal digit in any script. Unicode lays each script's
 * digits out as a contiguous run starting at zero, so the value is the
 * position in that run.
 */
function digitValue(ch: string): string {
  if (ch >= "0" && ch <= "9") return ch;
  let cp = ch.codePointAt(0)!;
  let n = 0;
  while (DIGIT.test(String.fromCodePoint(cp - 1))) {
    cp--;
    n++;
  }
  return String(n % 10);
}
