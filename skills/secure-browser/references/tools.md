# Tool reference

Nine working tools and one registered, unavailable stub. All results are redacted server-side before you see them.

Every browser tool (navigate, snapshot, click, type_text, fill_secret, await_fill, list_network_requests) also takes an optional `browser_id` from `open_browser`. With it, the tool acts in that browser. Without it, the tool uses the connection's own browser. A connection with no browser of its own (an MCP 2026-07-28 client) must pass `browser_id`.

## open_browser

No arguments. Returns `{ browser_id, idle_timeout_seconds }`. Opens a broker-owned browser that outlives this connection: pass the `browser_id` to every later browser tool, from any connection of the same caller. Each browser has its own pages, element uids, redaction, and pending fills. The browser closes after `idle_timeout_seconds` without a tool call. Fails when the caller holds its limit of browsers; close one first.

## close_browser

`{ browser_id: string }` → `{ closed }`. Closes the browser. A fill still pending approval stays valid: pass its `fill_id` to `await_fill` in another browser. An unknown, closed, or timed-out `browser_id` fails with `Unknown browser_id`.

## list_secret_refs

`{ origin?: string, include_unbound?: boolean }`. Returns `{ backend: "mock" | "turnkey", refs: SecretRef[], hidden?: number }`. With `origin` (the page you are about to fill on, e.g. `https://buy.stripe.com`) only secrets bound to that origin come back. Secrets with no `sbm:origin` cannot be filled and are hidden unless `include_unbound` is true; `hidden` counts what was left out. The broker walks every page of the store, so a large organization is fully listed:

```jsonc
{
  "backend": "turnkey", // mock means fixed demo seeds, not your Turnkey store
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

`{ secret_id: string, element_uid?: string, fields?: [{key, element_uid}], intent?: string }` → outcome only (no value). Steps performed broker-side: resolve ref → resolve elements → enforce binding (origin, URL pattern, selector) → export from Turnkey → inject via CDP → tag fields for redaction. Throws a binding-violation error if the live page or an element doesn't match the secret's binding; do not retry elsewhere.

Single-value secrets take `element_uid`. A JSON-payload secret — its binding declares `sbm:fields`, a map from payload key to required selector — takes `fields` instead, filling several inputs in ONE call: one export, one approval. Example: a card secret with keys `number`/`expiry`/`cvc` fills all three checkout fields at once. Such a secret refuses a plain `element_uid` fill, so its whole payload never lands in one field.

`intent` (optional, up to 500 characters) says why the fill is needed, in one or two plain sentences, for the approvers of a consensus-gated export. Example: `"Log in to GitHub to rotate the deploy key, as the user asked"`. Never put a secret value in it.

When the export needs multi-party approval, returns `{ filled: false, status: "pending_approval", fill_id, activity_id, approval_url?, page_url, intent?, approver_note }` instead — see `await_fill`. `approval_url` is the fully qualified Turnkey dashboard link for that activity (absent on the mock backend); relay it to the user verbatim. `approver_note` is review text for the approver: the secret and page the broker checked, the stated intent labeled as unverified, and the approval link. Calling `fill_secret` again for the same secret and element returns the same `fill_id`, and the fill keeps the intent of the first call.

## await_fill

`{ fill_id: string, timeout_seconds?: number (default 30, max 120), element_uid?: string, fields?: { key, element_uid }[] }`. Completes a pending fill once approvers reach quorum: waits up to the timeout, re-validates the destination against the live page, injects. Returns `pending_approval` again (same fields, including `approval_url`) if the timeout passes first — the fill stays valid, call again. Fails permanently if the export is rejected. If the target element left the page (or a hosted broker restarted), the fill stays valid: navigate back, snapshot, and call `await_fill` again with the same `fill_id` and the new `element_uid` or `fields`.

## list_network_requests (unavailable)

Registered scaffold only: returns `not_implemented`. Do not plan workflows around this tool.
