# Demo: pay a Stripe test checkout with the real Turnkey backend

The real-world version of the fixture demo. An agent completes a purchase on a Stripe-hosted checkout page. The card details come from Turnkey Secrets and never enter the agent's context.

Everything here uses Stripe test mode and Stripe's public test card (`docs.stripe.com/testing`). Nothing real is charged. The card values are public; the demo shows the _flow_ a real card would follow.

## One-time setup

1. Enable Secrets (closed beta) on your Turnkey org.
2. Export API credentials for the org:

   ```sh
   export TURNKEY_API_PUBLIC_KEY=...
   export TURNKEY_API_PRIVATE_KEY=...
   export TURNKEY_ORGANIZATION_ID=...
   ```

3. Import the test card, bound to `https://checkout.stripe.com`:

   ```sh
   bun run scripts/import-stripe-test-card.ts
   ```

   This creates three secrets — `stripe-test-card-number`, `stripe-test-card-expiry`, `stripe-test-card-cvc` — each with `sbm:origin` and a field selector as static properties.

4. Create a test-mode payment link (refuses live keys):

   ```sh
   STRIPE_API_KEY=sk_test_... bun run scripts/create-stripe-payment-link.ts
   ```

## Run it

The scripted version (verified end to end against production Turnkey on 2026-08-26 — payment `succeeded`):

```sh
bun run scripts/demo-stripe-checkout.ts <payment-link-url>
```

The script is a plain MCP client: it uses only the server's tools, exactly as an agent would, and asserts at the end that the card number never appeared in anything the server sent. To drive it by hand instead:

1. `list_secret_refs` — the card secrets appear with their bindings. No values.
2. `navigate` to the payment link URL.
3. `snapshot` — find the email, name, ZIP, card number, expiry, and CVC fields.
4. `click` the "I am an AI agent acting on behalf of someone else" disclosure when Stripe shows it, and uncheck `enableStripePass` ("Save my information") — it defaults on and makes a phone number required.
5. `type_text` the email, name, and ZIP. These are not secrets; they round-trip visibly.
6. `fill_secret` three times: card number, expiry, CVC.
7. `snapshot` — all three card fields show `[REDACTED:secret-filled-field]`.
8. `click` Pay; `snapshot` until the receipt page replaces the form.

The result: a completed purchase in the Stripe test dashboard, and a transcript in which the card number never appears.

## What the bindings prove

Payment links render on `https://buy.stripe.com`; API-created Checkout sessions render on `https://checkout.stripe.com`. Bindings are immutable, so the import script creates a set for each origin — and the demo uses the mismatch as a live negative test: filling the `checkout.stripe.com`-bound secret on the payment-link page is rejected by the origin binding. Asking for a fill into the email field is likewise rejected by the selector binding. Both refusals happen broker-side regardless of what the page (or a prompt injection) told the agent to do.

## Known limits

- Stripe's hosted pages render card inputs in the page's own document (verified on `buy.stripe.com`). Stripe _Elements_ (embedded in a merchant page) uses cross-origin iframes, which the broker's main-frame-only snapshot cannot reach yet.
- The payment link must be created card-only (`payment_method_types[0]=card`, which the script does): the multi-method accordion opens visually under synthetic clicks, but its selection state never commits, and Stripe then rejects the submit with "payment method required".
- Expiry is stored as digits (`1234`); the checkout field formats it to `12 / 34` as it receives input. The fill verifier tolerates fields growing beyond the inserted length for this reason.
- The Secrets API has no delete yet, so a secret imported with a wrong binding stays; import a corrected one under a new name.
