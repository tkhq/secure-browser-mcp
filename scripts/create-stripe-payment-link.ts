/**
 * Create a test-mode Stripe payment link for the checkout demo:
 *
 *   STRIPE_API_KEY=sk_test_... bun run scripts/create-stripe-payment-link.ts
 *
 * Refuses live keys: this script exists to produce a checkout page the demo
 * can pay with Stripe's public test card, nothing more.
 */
const key = process.env["STRIPE_API_KEY"];
if (!key) {
  console.error("Set STRIPE_API_KEY (a test-mode secret key)");
  process.exit(1);
}
if (!/^(sk|rk)_test_/.test(key)) {
  console.error(
    "Refusing: STRIPE_API_KEY is not a test-mode key (sk_test_/rk_test_)",
  );
  process.exit(1);
}

async function stripe(
  path: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(body["error"])}`);
  return body;
}

const price = await stripe("prices", {
  currency: "usd",
  unit_amount: "999",
  "product_data[name]": "secure-browser-mcp demo item",
});
const link = await stripe("payment_links", {
  "line_items[0][price]": String(price["id"]),
  "line_items[0][quantity]": "1",
  // Card only: the multi-method accordion resists synthetic radio selection
  // (visual state opens, React selection state does not commit).
  "payment_method_types[0]": "card",
});

console.log(`Payment link: ${link["url"]}`);
console.log("Point the agent at this URL and pay with the imported test card.");
