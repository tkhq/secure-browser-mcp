/**
 * Import Stripe's standard test card into Turnkey Secrets, bound to the
 * hosted checkout page. Run once against an org with Secrets enabled:
 *
 *   TURNKEY_API_PUBLIC_KEY=... TURNKEY_API_PRIVATE_KEY=... \
 *   TURNKEY_ORGANIZATION_ID=... bun run scripts/import-stripe-test-card.ts
 *
 * These are Stripe's PUBLIC test values (docs.stripe.com/testing) — safe to
 * store anywhere. The point of the exercise is the flow: once imported with
 * bindings, the agent can complete a checkout without the "card number" ever
 * appearing in its context, exactly as a real card would work.
 */
import { BINDING_KEYS } from "../src/broker/types.js";
import { turnkeyClientFromEnv } from "../src/broker/turnkey-env.js";

// Two sets: payment links render on buy.stripe.com; sessions created via the
// Checkout API render on checkout.stripe.com. Bindings are immutable static
// properties, so each origin gets its own secrets. Digits only: Stripe's
// fields format as they receive input, so the broker inserts raw digits and
// lets the page add separators.
const CARD_VALUES = [
  {
    field: "number",
    plaintext: "4242424242424242",
    selector: "input[name=cardNumber]",
  },
  { field: "expiry", plaintext: "1234", selector: "input[name=cardExpiry]" },
  { field: "cvc", plaintext: "123", selector: "input[name=cardCvc]" },
];

const CARD_SECRETS = [
  ...CARD_VALUES.map((v) => ({
    name: `stripe-test-card-${v.field}`,
    plaintext: v.plaintext,
    selector: v.selector,
    origin: "https://checkout.stripe.com",
  })),
  ...CARD_VALUES.map((v) => ({
    name: `stripe-paylink-card-${v.field}`,
    plaintext: v.plaintext,
    selector: v.selector,
    origin: "https://buy.stripe.com",
  })),
];

const client = turnkeyClientFromEnv();
if (!client) {
  console.error(
    "Set TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID",
  );
  process.exit(1);
}

const existing = new Set(
  (await client.getSecrets({})).map((s) => s.name).filter(Boolean),
);

for (const { name, plaintext, selector, origin } of CARD_SECRETS) {
  if (existing.has(name)) {
    console.log(`skip   ${name} (already imported)`);
    continue;
  }
  const secretId = await client.importSecret({
    name,
    plaintext,
    staticProperties: {
      [BINDING_KEYS.origin]: origin,
      [BINDING_KEYS.selector]: selector,
    },
  });
  console.log(`import ${name} → ${secretId} (${origin})`);
}
console.log("Done.");
