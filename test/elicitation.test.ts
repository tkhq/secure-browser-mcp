import { expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  createMcpHandler,
  type ClientCapabilities,
  type ElicitResult,
} from "@modelcontextprotocol/server";

import {
  MemoryPendingFillStore,
  scopedFills,
} from "../src/broker/pending-store.js";
import { MockSecretsClient } from "../src/broker/mock-secrets.js";
import { BrowserHandles, browserScope } from "../src/browsers.js";
import { brokerContext, browserContext, makeBroker } from "../src/runtime.js";
import { createServer } from "../src/server.js";
import { FIXTURE_ORIGIN, startFixtureServer } from "./fixtures/serve.js";

const draft = {
  name: "checkout-card",
  origin: "https://shop.example",
  fields: { number: "#card-number", cvc: "#cvc" },
  url_pattern: "/checkout*",
};

async function connect(
  version: "2025-11-25" | "2026-07-28",
  capabilities: ClientCapabilities,
  action: ElicitResult["action"] = "accept",
) {
  const broker = makeBroker({
    client: new MockSecretsClient(undefined, {
      consensusNames: ["demo-login-password"],
      approvalDelayMs: 60_000,
    }),
    backend: "turnkey",
    organizationId: "expected-org",
  });
  const handles = new BrowserHandles(
    { max: 4, perEndpoint: 4, perPrincipal: () => 4 },
    60_000,
  );
  const fills = scopedFills(new MemoryPendingFillStore(), {
    owner: "test",
    principal: "test",
    isLive: () => true,
  });
  const implicit = browserContext(broker, fills);
  const browsers = browserScope({
    handles,
    owner: { endpoint: "test", principal: "test", client: undefined },
    make: () => browserContext(broker, fills),
    implicit,
  });
  const server = createServer(brokerContext(broker, browsers));
  const client = new Client(
    { name: "elicitation-test", version: "0" },
    {
      capabilities,
      versionNegotiation: {
        mode: version === "2026-07-28" ? { pin: version } : "legacy",
      },
    },
  );
  const requests: {
    mode?: string | undefined;
    url?: string | undefined;
    elicitationId?: string | undefined;
  }[] = [];
  if (capabilities.elicitation)
    client.setRequestHandler("elicitation/create", async (request) => {
      requests.push(request.params);
      return { action };
    });
  let http: ReturnType<typeof Bun.serve> | undefined;
  if (version === "2026-07-28") {
    const handler = createMcpHandler(
      () => createServer(brokerContext(broker, browsers)),
      { legacy: "reject" },
    );
    http = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handler.fetch(request),
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
  } else {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }
  return {
    requests,
    fills,
    call: async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      if (!("content" in result))
        throw new Error("Expected a complete tool result");
      const text = result.content[0];
      if (text?.type !== "text") throw new Error("Expected text result");
      let body;
      try {
        body = JSON.parse(text.text);
      } catch {
        body = text.text;
      }
      return { isError: result.isError === true, body };
    },
    close: async () => {
      await client.close();
      await server.close();
      http?.stop(true);
      await implicit.session.close();
      await handles.closeAll();
    },
  };
}

for (const version of ["2025-11-25", "2026-07-28"] as const) {
  for (const action of ["accept", "decline", "cancel"] as const) {
    test(`${version}: import handoff ${action} never claims creation`, async () => {
      const connection = await connect(
        version,
        { elicitation: { url: {} } },
        action,
      );
      try {
        const result = await connection.call("create_secret", draft);
        expect(result.isError).toBe(false);
        expect(result.body).toMatchObject({
          created: false,
          status: action === "accept" ? "pending_import" : action,
          elicitation_action: action,
        });
        expect(connection.requests).toHaveLength(1);
        const request = connection.requests[0]!;
        expect(request.mode).toBe("url");
        const url = new URL(request.url!);
        expect(url.pathname).toBe("/dashboard/v2/secrets");
        expect(url.searchParams.get("organizationId")).toBe("expected-org");
        expect(url.searchParams.get("create")).toBe("true");
        expect(JSON.parse(url.searchParams.get("name")!)).toBe("checkout-card");
        expect(JSON.parse(url.searchParams.get("staticProperties")!)).toEqual([
          { key: "sbm:origin", value: "https://shop.example" },
          { key: "sbm:url-pattern", value: "/checkout*" },
          {
            key: "sbm:fields",
            value: '{"number":"#card-number","cvc":"#cvc"}',
          },
        ]);
        expect(url.searchParams.has("value")).toBe(false);
        const refs = await connection.call("list_secret_refs");
        expect(
          refs.body.refs.some(
            (ref: { name: string }) => ref.name === draft.name,
          ),
        ).toBe(false);
      } finally {
        await connection.close();
      }
    });
  }

  test(`${version}: absent/form-only capabilities use the ordinary link`, async () => {
    for (const capabilities of [
      {},
      { elicitation: {} },
      { elicitation: { form: {} } },
    ]) {
      const connection = await connect(version, capabilities);
      try {
        const result = await connection.call("create_secret", draft);
        expect(result.body).toMatchObject({
          created: false,
          status: "pending_import",
        });
        expect(result.body.import_url).toContain("/secrets?create=true");
        expect(connection.requests).toHaveLength(0);
      } finally {
        await connection.close();
      }
    }
  });

  test(`${version}: accepting an approval URL does not reach quorum or fill`, async () => {
    const fixture = startFixtureServer();
    const connection = await connect(version, { elicitation: { url: {} } });
    try {
      await connection.call("navigate", { url: `${FIXTURE_ORIGIN}/login` });
      const snapshot = await connection.call("snapshot");
      const password = snapshot.body.elements.find(
        (element: { type: string }) => element.type === "password",
      );
      const refs = await connection.call("list_secret_refs");
      const ref = refs.body.refs.find(
        (ref: { name: string }) => ref.name === "demo-login-password",
      );
      const args = { secret_id: ref.secretId, element_uid: password.uid };
      const pending = await connection.call("fill_secret", args);
      expect(pending.body).toMatchObject({
        filled: false,
        status: "pending_approval",
        elicitation_action: "accept",
      });
      expect(connection.requests).toHaveLength(1);
      expect(connection.requests[0]!.url).toContain("/activities/");
      const retry = await connection.call("fill_secret", args);
      expect(retry.body.fill_id).toBe(pending.body.fill_id);
      expect(connection.fills.list()).toHaveLength(1);
      const awaited = await connection.call("await_fill", {
        fill_id: pending.body.fill_id,
        timeout_seconds: 1,
      });
      expect(awaited.body).toMatchObject({
        filled: false,
        status: "pending_approval",
      });
      const after = await connection.call("snapshot");
      expect(
        after.body.elements.find(
          (element: { uid: string }) => element.uid === password.uid,
        )?.value,
      ).not.toBe("[REDACTED:secret-filled-field]");
    } finally {
      await connection.close();
      fixture.stop();
    }
  }, 20_000);
}

test("invalid creation bindings cannot produce an elicitation", async () => {
  const connection = await connect("2025-11-25", { elicitation: { url: {} } });
  try {
    for (const args of [
      { ...draft, selector: "#password" },
      { ...draft, fields: undefined },
      { ...draft, origin: "https://shop.example/login" },
      { ...draft, origin: "https://*.example" },
      { ...draft, url_pattern: "//example.com/*" },
      { ...draft, url_pattern: "/checkout?next=*" },
      { ...draft, url_pattern: "/checkout#*" },
      { ...draft, url_pattern: "/check out*" },
      { ...draft, url_pattern: "/check\\out*" },
      { ...draft, fields: {} },
      { ...draft, fields: { number: " " } },
    ]) {
      const result = await connection.call("create_secret", args);
      expect(result.isError).toBe(true);
    }
    expect(connection.requests).toHaveLength(0);
  } finally {
    await connection.close();
  }
});
