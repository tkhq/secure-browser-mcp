/** Import a bound secret outside the agent session. Never accept plaintext in argv. */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { BINDING_KEYS } from "../src/broker/types.js";
import { turnkeyClientFromEnv } from "../src/broker/turnkey-env.js";

class InputError extends Error {}
const fail = (message: string): never => {
  throw new InputError(message);
};

export function parseImport(args: string[], env: NodeJS.ProcessEnv) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        name: { type: "string" },
        origin: { type: "string" },
        "url-pattern": { type: "string" },
        selector: { type: "string" },
        fields: { type: "string" },
        "value-env": { type: "string" },
      },
    }));
  } catch {
    return fail(
      "Invalid arguments. Use --help. Secret values must never be command-line arguments.",
    );
  }
  const { name, origin, selector, fields } = values;
  if (!name?.trim() || !origin) return fail("Provide --name and --origin.");
  try {
    const url = new URL(origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== origin)
      return fail(
        "--origin must be an exact HTTP(S) origin without a path or trailing slash.",
      );
  } catch {
    return fail(
      "--origin must be an exact HTTP(S) origin without a path or trailing slash.",
    );
  }
  if (Boolean(selector) === Boolean(fields))
    return fail("Provide exactly one of --selector or --fields.");
  if (selector !== undefined && !selector.trim())
    return fail("--selector must not be blank.");
  const staticProperties: Record<string, string> = {
    [BINDING_KEYS.origin]: origin,
  };
  if (selector) staticProperties[BINDING_KEYS.selector] = selector;
  const pattern = values["url-pattern"];
  if (pattern !== undefined) {
    if (!pattern.startsWith("/"))
      return fail("--url-pattern must be a pathname pattern starting with /.");
    try {
      new URLPattern({ pathname: pattern, baseURL: origin });
    } catch {
      return fail("Invalid pathname pattern.");
    }
    staticProperties[BINDING_KEYS.urlPattern] = pattern;
  }
  const variable = values["value-env"];
  if (!variable || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable))
    return fail(
      "Provide --value-env with the name of an environment variable containing the secret.",
    );
  const plaintext = env[variable];
  if (!plaintext)
    return fail("The secret environment variable is empty or missing.");
  if (fields) {
    let mapping: unknown, payload: unknown;
    try {
      mapping = JSON.parse(fields);
      payload = JSON.parse(plaintext);
    } catch {
      return fail("--fields and the secret payload must be JSON objects.");
    }
    const object = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    if (!object(mapping) || !object(payload))
      return fail("--fields and the secret payload must be JSON objects.");
    const keys = Object.keys(mapping);
    if (
      !keys.length ||
      keys.some(
        (key) =>
          !key.trim() ||
          typeof mapping[key] !== "string" ||
          !(mapping[key] as string).trim(),
      )
    )
      return fail(
        "--fields must map nonempty payload keys to nonempty CSS selectors.",
      );
    if (
      Object.keys(payload).length !== keys.length ||
      keys.some(
        (key) =>
          !Object.hasOwn(payload, key) ||
          typeof payload[key] !== "string" ||
          !payload[key],
      )
    )
      return fail(
        "The secret payload must contain exactly the mapped keys, each with a nonempty string value.",
      );
    staticProperties[BINDING_KEYS.fields] = JSON.stringify(mapping);
  }
  return { name, plaintext, staticProperties };
}

type ImportClient = {
  importSecret: (input: ReturnType<typeof parseImport>) => Promise<string>;
};
export async function runImport(
  args: string[],
  env: NodeJS.ProcessEnv,
  dependencies: {
    client: () => ImportClient | undefined;
    confirm: (summary: string) => Promise<boolean>;
    write: (message: string) => void;
  },
) {
  const input = parseImport(args, env);
  if (
    ![
      "TURNKEY_API_PUBLIC_KEY",
      "TURNKEY_API_PRIVATE_KEY",
      "TURNKEY_ORGANIZATION_ID",
    ].every((key) => env[key]?.trim())
  )
    return fail(
      "Set all three TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, and TURNKEY_ORGANIZATION_ID variables. Import never uses mock.",
    );
  const summary = JSON.stringify(
    { name: input.name, staticProperties: input.staticProperties },
    null,
    2,
  );
  if (!(await dependencies.confirm(summary)))
    return fail("Import cancelled; no secret was created.");
  const client = dependencies.client();
  if (!client) return fail("Turnkey credentials are required.");
  // Do not print SDK errors: they may contain request data or plaintext.
  let secretId: string;
  try {
    secretId = await client.importSecret(input);
  } catch {
    return fail(
      "Turnkey import failed; details withheld to protect secret material. Check access and existing secrets before retrying; the request may have succeeded.",
    );
  }
  dependencies.write(
    JSON.stringify(
      { secretId, name: input.name, staticProperties: input.staticProperties },
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  if (process.argv.slice(2).includes("--help")) {
    console.log(
      "Usage: bun run scripts/import-secret.ts --name NAME --origin ORIGIN [--url-pattern '/login*'] (--selector CSS | --fields JSON) --value-env ENV_NAME\nRead the value from ENV_NAME, never argv. Requires all three TURNKEY_* credentials and interactive confirmation. Bindings are immutable; verify selectors before import.",
    );
  } else {
    try {
      await runImport(process.argv.slice(2), process.env, {
        client: turnkeyClientFromEnv,
        confirm: async (summary) => {
          if (!process.stdin.isTTY || !process.stdout.isTTY)
            return fail(
              "Run in an interactive terminal to confirm the binding before import.",
            );
          console.log(summary);
          console.log(
            "Bindings are immutable; this repository has no secret deletion workflow. Verify these selectors on the live page before continuing.",
          );
          const terminal = createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          try {
            return (
              (
                await terminal.question('Type "import" to create this secret: ')
              ).trim() === "import"
            );
          } finally {
            terminal.close();
          }
        },
        write: (message) => console.log(message),
      });
    } catch (error) {
      console.error(
        error instanceof InputError
          ? error.message
          : "Import failed; error details withheld to protect secret material.",
      );
      process.exitCode = 1;
    }
  }
}
