import { parseBinding } from "@turnkey/browser-secrets";
import { z } from "zod";

import { BINDING_KEYS } from "../broker/types.js";
import { defineTool } from "./tool.js";

export const createSecret = defineTool({
  name: "create_secret",
  // This only proposes metadata; the human authenticates and authorizes
  // the import in the dashboard. It grants no broker-side write access.
  scope: "sbm:refs",
  browser: false,
  description:
    "Ask a human to create a destination-bound secret in the Turnkey dashboard. " +
    "Provide only a non-sensitive name and verified destination bindings, NEVER " +
    "a secret value. The human opens a separate browser, reviews the proposed " +
    "immutable bindings, and enters the value there. Opening the link does not " +
    "create a secret. After the human completes import, call list_secret_refs " +
    "and verify the resulting binding before filling. Do not navigate the " +
    "agent-controlled browser to this URL.",
  inputSchema: {
    name: z.string().trim().min(1).max(256),
    origin: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            ["https:", "http:"].includes(url.protocol) &&
            url.origin === value &&
            !url.hostname.includes("*")
          );
        } catch {
          return false;
        }
      }, "Provide an exact HTTP(S) origin, with no path or trailing slash"),
    url_pattern: z
      .string()
      .min(1)
      .max(1024)
      .startsWith("/")
      .refine(
        (value) => !value.startsWith("//") && !/[?#\\\s]/.test(value),
        "Provide a pathname pattern, without query, fragment, whitespace, or backslash",
      )
      .optional(),
    selector: z.string().trim().min(1).max(1024).optional(),
    fields: z
      .record(
        z.string().trim().min(1).max(64),
        z.string().trim().min(1).max(1024),
      )
      .refine(
        (value) =>
          Object.keys(value).length > 0 && Object.keys(value).length <= 16,
        "Provide between 1 and 16 payload-key to CSS-selector mappings",
      )
      .optional(),
  },
  handler: async (ctx, args) => {
    if (ctx.backend !== "turnkey" || !ctx.createSecretUrl)
      throw new Error(
        "Dashboard secret creation requires a configured Turnkey backend",
      );
    if (Boolean(args.selector) === Boolean(args.fields))
      throw new Error("Provide exactly one of selector or fields");
    const properties: Record<string, string> = {
      [BINDING_KEYS.origin]: args.origin,
      ...(args.url_pattern
        ? { [BINDING_KEYS.urlPattern]: args.url_pattern }
        : {}),
      ...(args.selector ? { [BINDING_KEYS.selector]: args.selector } : {}),
      ...(args.fields
        ? { [BINDING_KEYS.fields]: JSON.stringify(args.fields) }
        : {}),
    };
    if (parseBinding(properties).status !== "bound")
      throw new Error("Invalid destination binding");
    const url = ctx.createSecretUrl(args.name, properties);
    if (!url)
      throw new Error(
        "No dashboard URL configured for this Turnkey environment",
      );
    const action = await ctx.requestUrl?.({
      mode: "url",
      elicitationId: "create_secret",
      url,
      message:
        "Create a secret in Turnkey. Review the proposed destination bindings and enter the value only in the dashboard, never in chat.",
    });
    return {
      status:
        action === "decline" || action === "cancel" ? action : "pending_import",
      created: false,
      import_url: url,
      ...(action ? { elicitation_action: action } : {}),
      message:
        action === "decline" || action === "cancel"
          ? "Dashboard handoff dismissed. No secret was created by this tool. Do not reopen without the human's request."
          : "The human must review the bindings and create the secret in a separate dashboard browser. This tool does not confirm completion. Once the human finishes, call list_secret_refs and verify the destination binding. Never open this URL with the agent-controlled browser.",
    };
  },
});
