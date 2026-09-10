import { expect, test } from "bun:test";
import { parseImport, runImport } from "../scripts/import-secret.js";
import { listSecretRefs } from "../src/tools/list-secret-refs.js";
import { MockSecretsClient } from "../src/broker/mock-secrets.js";
import { BindingPolicy } from "../src/broker/binding.js";
import { BrowserSession } from "../src/browser/session.js";
import { RedactionRegistry } from "../src/redaction/registry.js";

const secret = "canary-never-print-this";
const env = {
  VALUE: secret,
  TURNKEY_API_PUBLIC_KEY: "public",
  TURNKEY_API_PRIVATE_KEY: "private",
  TURNKEY_ORGANIZATION_ID: "org",
};
const args = [
  "--name",
  "site-login",
  "--origin",
  "https://example.com",
  "--selector",
  "input[type=password]",
  "--value-env",
  "VALUE",
];

test("import requires credentials and confirmation before any API call", async () => {
  let calls = 0;
  const dependencies = {
    client: () => {
      calls++;
      return { importSecret: async () => "id" };
    },
    confirm: async () => false,
    write: () => {},
  };
  await expect(
    runImport(args, { VALUE: secret }, dependencies),
  ).rejects.toThrow("Set all three");
  await expect(runImport(args, env, dependencies)).rejects.toThrow("cancelled");
  expect(calls).toBe(0);
});

test("confirmed import sends bindings and value but displays only metadata", async () => {
  const output: string[] = [];
  let calls = 0;
  await runImport(args, env, {
    confirm: async (summary) => {
      output.push(summary);
      return true;
    },
    client: () => ({
      importSecret: async (input) => {
        calls++;
        expect(input.plaintext).toBe(secret);
        expect(input.staticProperties).toEqual({
          "sbm:origin": "https://example.com",
          "sbm:selector": "input[type=password]",
        });
        return "created-id";
      },
    }),
    write: (message) => output.push(message),
  });
  expect(calls).toBe(1);
  expect(output.join("\n")).not.toContain(secret);
  expect(JSON.parse(output[1]!).secretId).toBe("created-id");
});

test("SDK error details never leak plaintext", async () => {
  await expect(
    runImport(args, env, {
      confirm: async () => true,
      client: () => ({
        importSecret: async () => {
          throw new Error(secret);
        },
      }),
      write: () => {
        throw new Error("must not report success");
      },
    }),
  ).rejects.toThrow("details withheld");
});

test("invalid arguments fail without echoing input", () => {
  expect(() => parseImport([...args, "--value", secret], env)).toThrow(
    "Invalid arguments",
  );
  for (const origin of [
    "https://example.com/",
    "https://example.com/login",
    "https://user:pass@example.com",
    "file:///tmp",
  ]) {
    const invalid = [...args];
    invalid[3] = origin;
    expect(() => parseImport(invalid, env)).toThrow("exact HTTP(S) origin");
  }
  expect(() => parseImport([...args, "--fields", "{}"], env)).toThrow(
    "exactly one",
  );
});

test("multi-field imports require exact string payload keys", () => {
  const multi = [
    "--name",
    "card",
    "--origin",
    "https://example.com",
    "--fields",
    '{"number":"input[name=number]","cvc":"input[name=cvc]"}',
    "--value-env",
    "VALUE",
  ];
  const input = parseImport(multi, { VALUE: '{"number":"4242","cvc":"123"}' });
  expect(JSON.parse(input.staticProperties["sbm:fields"]!)).toEqual({
    number: "input[name=number]",
    cvc: "input[name=cvc]",
  });
  for (const payload of [
    "{broken",
    "[]",
    '{"number":4242,"cvc":"123"}',
    '{"number":"4242"}',
    '{"number":"4242","cvc":"123","extra":"x"}',
  ])
    expect(() => parseImport(multi, { VALUE: payload })).toThrow();
});

for (const backend of ["mock", "turnkey"] as const) {
  test(`list_secret_refs exposes ${backend} without changing refs`, async () => {
    const secrets = new MockSecretsClient();
    const result = await listSecretRefs.handler(
      {
        backend,
        secrets,
        session: new BrowserSession({
          executablePath: "/unused",
          headless: true,
        }),
        registry: new RedactionRegistry(),
        binding: new BindingPolicy(),
        pendingFills: new Map(),
      },
      {},
    );
    expect(result).toEqual({ backend, refs: await secrets.listRefs() });
    expect(JSON.stringify(result)).not.toContain("mock-demo-p@ssw0rd-1234");
  });
}

test("MCP stdio response includes the selected mock backend", async () => {
  const { McpStdioClient } = await import("./mcp-client.js");
  const client = new McpStdioClient({
    TURNKEY_API_PUBLIC_KEY: "",
    TURNKEY_API_PRIVATE_KEY: "",
    TURNKEY_ORGANIZATION_ID: "",
    SBM_CHROME_PATH: "/unused-for-reference-listing",
  });
  try {
    await client.initialize();
    const result = await client.callTool("list_secret_refs");
    expect(result.isError).toBe(false);
    expect(result.body).toMatchObject({ backend: "mock" });
    expect(client.transcript).not.toContain("mock-demo-p@ssw0rd-1234");
  } finally {
    await client.stop();
  }
});
