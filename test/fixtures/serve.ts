/**
 * Tiny fixture server for the demo: serves login.html at /login on the port
 * the mock demo secret is bound to. Run with `bun run demo:fixture`, or let
 * the e2e test start it itself.
 */
export const FIXTURE_PORT = 4173;
export const FIXTURE_ORIGIN = `http://localhost:${FIXTURE_PORT}`;

export function startFixtureServer(): { stop: () => void } {
  const html = Bun.file(new URL("./login.html", import.meta.url));
  const server = Bun.serve({
    port: FIXTURE_PORT,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/login") return new Response(html);
      if (pathname === "/session" && req.method === "POST") {
        return new Response("ok");
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
