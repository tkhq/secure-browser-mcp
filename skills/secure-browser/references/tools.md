# Tool reference

Seven tools. All results are redacted server-side before you see them.

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

`{ secret_id: string, element_uid: string }` → outcome only (no value). Steps performed broker-side: resolve ref → resolve element → enforce binding (origin, URL pattern, selector) → export from Turnkey → inject via CDP → tag field for redaction. Throws a binding-violation error if the live page or element doesn't match the secret's binding; do not retry elsewhere.

## list_network_requests

No arguments. Metadata only (method, URL, status); request bodies are withheld for origins holding live secrets. Currently not implemented.
