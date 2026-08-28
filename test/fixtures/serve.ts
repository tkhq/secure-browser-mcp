/**
 * Tiny fixture server for the demo: a login page at /login, then a fake
 * checkout at /checkout after signing in. Run with `bun run demo:fixture`,
 * or let the e2e test start it itself. Nothing is real: the "payment" just
 * echoes a receipt page.
 */
export const FIXTURE_PORT = 4173;
export const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

export function startFixtureServer(): { stop: () => void } {
  const loginHtml = Bun.file(new URL("./login.html", import.meta.url));
  const checkoutHtml = Bun.file(new URL("./checkout.html", import.meta.url));
  const receiptHtml = Bun.file(new URL("./receipt.html", import.meta.url));
  const server = Bun.serve({
    port: FIXTURE_PORT,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/login") return new Response(loginHtml);
      if (pathname === "/session" && req.method === "POST") {
        // Logged in: send the browser on to the checkout page.
        return new Response(null, {
          status: 303,
          headers: { Location: "/checkout" },
        });
      }
      if (pathname === "/checkout") return new Response(checkoutHtml);
      if (pathname === "/pay" && req.method === "POST") {
        return new Response(receiptHtml);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { stop: () => server.stop(true) };
}

if (import.meta.main) {
  startFixtureServer();
  console.error(`fixture: serving login page at ${FIXTURE_ORIGIN}/login`);
}
