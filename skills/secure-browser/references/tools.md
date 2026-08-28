# Tool reference

Eight tools. All results are redacted server-side before you see them.

## list_secret_refs

No arguments. Returns `{ refs: SecretRef[] }`:

```jsonc
{
  "refs": [
    {
      "secretId": "…", // pass this to fill_secret
      "name": "stripe-paylink-card-number",
      "staticProperties": { "sbm:origin": "https://buy.stripe.com", "…": "…" },
      "binding": {
        "origin": "https://buy.stripe.com", // required page origin
        "urlPattern": "/pay/*", // optional URLPattern
        "selector": "input[name=cardNumber]", // optional: element must match
      },
    },
  ],
}
```

No tool ever returns a secret's value.

## navigate

`{ url: string }` → `{ url, title }`. Loads the page in the broker's browser. Invalidates all element uids.

## snapshot

No arguments. Returns `{ url, title, elements: [...] }` where each element has:

- `uid` — targeting handle for click/type_text/fill_secret; valid until the next navigation
- `tag`, `type`, `name`, `label`, `text`, `value` as available

Field values are redacted: `[REDACTED:secret-filled-field]` after a fill, `[MASKED:password-field]` for password inputs.

## click

`{ element_uid: string }` → `{ clicked }`. Coordinate click with a DOM-click fallback for hidden/custom-styled controls (checkboxes, radios).

## type_text

`{ element_uid: string, text: string }` → `{ typed, length }`. For non-secret text only. Never pass a secret value here — it would land in the conversation transcript.

## fill_secret

`{ secret_id: string, element_uid?: string, fields?: [{key, element_uid}] }` → outcome only (no value). Steps performed broker-side: resolve ref → resolve elements → enforce binding (origin, URL pattern, selector) → export from Turnkey → inject via CDP → tag fields for redaction. Throws a binding-violation error if the live page or an element doesn't match the secret's binding; do not retry elsewhere.

Single-value secrets take `element_uid`. A JSON-payload secret — its binding declares `sbm:fields`, a map from payload key to required selector — takes `fields` instead, filling several inputs in ONE call: one export, one approval. Example: a card secret with keys `number`/`expiry`/`cvc` fills all three checkout fields at once.

When the export needs multi-party approval, returns `{ filled: false, status: "pending_approval", fill_id, activity_id }` instead — see `await_fill`. Calling `fill_secret` again for the same secret and element returns the same `fill_id`.

## await_fill

`{ fill_id: string, timeout_seconds?: number (default 30, max 120) }`. Completes a pending fill once approvers reach quorum: waits up to the timeout, re-validates the destination against the live page, injects. Returns `pending_approval` again if the timeout passes first — the fill stays valid, call again. Fails permanently if the export is rejected, the broker restarted, or the target element left the page.

## list_network_requests

No arguments. Metadata only (method, URL, status); request bodies are withheld for origins holding live secrets. Currently not implemented.
