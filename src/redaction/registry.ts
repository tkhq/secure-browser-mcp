/**
 * Tracks which secret material is "live" — exported and possibly present in
 * the page, network requests, or console output — so every tool result can
 * be scrubbed before it reaches the agent.
 *
 * Two registries:
 *  - plaintext scrub-set: exact values to value-scan out of any output
 *    (backstop; catches secrets echoed via network bodies, console, etc.)
 *  - tagged fields: element uids whose values must be structurally elided
 *    from snapshots (primary; does not depend on spotting the value)
 */
export class RedactionRegistry {
  private readonly plaintexts = new Map<string, string>(); // value → secretId
  private readonly taggedFields = new Map<string, string>(); // elementUid → secretId

  /** Register a live plaintext the moment it is exported into broker memory. */
  trackValue(plaintext: string, secretId: string): void {
    this.plaintexts.set(plaintext, secretId);
  }

  /** Register a field that received a secret, keyed by snapshot element uid. */
  trackField(elementUid: string, secretId: string): void {
    this.taggedFields.set(elementUid, secretId);
  }

  isTaggedField(elementUid: string): boolean {
    return this.taggedFields.has(elementUid);
  }

  /** Value-scan: replace every occurrence of a live plaintext in `text`. */
  scrubText(text: string): string {
    let out = text;
    for (const [value, secretId] of this.plaintexts) {
      if (value.length === 0) continue;
      out = out.split(value).join(`[REDACTED:${secretId}]`);
    }
    return out;
  }
}
