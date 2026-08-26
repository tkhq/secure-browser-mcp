import { captureSnapshot } from "../browser/snapshot.js";
import { defineTool } from "./tool.js";

export const snapshot = defineTool({
  name: "snapshot",
  description:
    "Snapshot of the current page's interactive elements with stable " +
    "element uids for click/type/fill targeting. Values of fields that " +
    "received a secret are structurally redacted.",
  inputSchema: {},
  handler: async (ctx) => {
    // Structural redaction (tagged fields, password inputs) happens inside
    // captureSnapshot, before values ever enter the result; the global
    // scrub() value-scan is the backstop.
    return captureSnapshot(ctx.session, ctx.registry);
  },
});
