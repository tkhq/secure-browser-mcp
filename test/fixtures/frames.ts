/**
 * Iframe and shadow-root fixture pages. One server answers as two origins:
 * the merchant on `localhost` and the payment provider on `127.0.0.1`, which
 * Chrome treats as different sites, so provider frames run out of process
 * (OOPIF). A second server is a third origin on the same site as the
 * merchant: a cross-origin frame that stays in the merchant's process, and
 * an unapproved top-level page that embeds the provider's frames.
 *
 * The ports are fixed because the @turnkey/browser-secrets conformance
 * fixture names these URLs (test/observe.test.ts runs its iframe cases
 * against these pages).
 */
export const FRAMES_PORT = 5001;
export const OTHER_PORT = 5002;
export const MERCHANT = `http://localhost:${FRAMES_PORT}`;
export const PROVIDER = `http://127.0.0.1:${FRAMES_PORT}`;
export const OTHER = `http://localhost:${OTHER_PORT}`;

const html = (body: string): Response =>
  new Response(body, { headers: { "content-type": "text/html" } });

/** A provider-style field page: one input and a button, in its own document. */
function field(name: string): Response {
  return html(
    `<!doctype html><title>Field</title>` +
      `<input name="${name}" autocomplete="off">` +
      `<button name="button" onclick="this.textContent='clicked'">Click</button>`,
  );
}

/** The merchant checkout: every kind of frame and shadow root in one page. */
const CHECKOUT = `<!doctype html><title>Frame checkout</title>
<input name="main" autocomplete="off">
<div id="host"></div>
<div id="closed"></div>
<iframe id="same" src="${MERCHANT}/field?name=same"></iframe>
<iframe id="other" src="${OTHER}/field?name=other"></iframe>
<iframe id="cross" src="${PROVIDER}/field?name=cross"></iframe>
<iframe id="sandbox" sandbox="allow-scripts" src="${PROVIDER}/field?name=sandbox"></iframe>
<iframe id="nested" src="${PROVIDER}/wrapper"></iframe>
<iframe id="unbound" src="${OTHER}/wrapper"></iframe>
<iframe id="srcdoc" srcdoc='<input name="srcdoc">'></iframe>
<script>
  const root = document.querySelector("#host").attachShadow({ mode: "open" });
  root.innerHTML = '<div id="inner"></div>';
  root.querySelector("#inner").attachShadow({ mode: "open" }).innerHTML =
    '<input name="shadow" autocomplete="off">';
  document.querySelector("#closed").attachShadow({ mode: "closed" }).innerHTML =
    '<input name="closed">';
</script>`;

/** A Stripe Elements-style card form: one provider iframe for each part. */
const PAY = `<!doctype html><title>Frame pay</title>
<input name="cardholder" autocomplete="off">
<iframe id="number" src="${PROVIDER}/field?name=number"></iframe>
<iframe id="expiry" src="${PROVIDER}/field?name=expiry"></iframe>
<iframe id="cvc" src="${PROVIDER}/field?name=cvc"></iframe>`;

function route(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname === "/field") {
    const name = url.searchParams.get("name") ?? "";
    if (!/^[a-z]+$/.test(name))
      return new Response("bad name", { status: 400 });
    return field(name);
  }
  if (url.pathname === "/wrapper") {
    return html(`<iframe src="${PROVIDER}/field?name=nested"></iframe>`);
  }
  if (url.pathname === "/checkout") return html(CHECKOUT);
  if (url.pathname === "/pay") return html(PAY);
  return new Response("not found", { status: 404 });
}

export function startFrameFixture(): { stop: () => void } {
  const servers = [FRAMES_PORT, OTHER_PORT].map((port) =>
    Bun.serve({ hostname: "127.0.0.1", port, fetch: route }),
  );
  return { stop: () => servers.forEach((s) => s.stop(true)) };
}
