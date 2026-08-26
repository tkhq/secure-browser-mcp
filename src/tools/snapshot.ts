import { defineTool, NotImplementedError } from "./tool.js";

export const snapshot = defineTool({
  name: "snapshot",
  description:
    "Accessibility-tree snapshot of the current page with stable element " +
    "uids for click/type/fill targeting. Values of fields that received a " +
    "secret are structurally redacted.",
  inputSchema: {},
  handler: async (_ctx) => {
    // Serialize the a11y tree; consult ctx.registry.isTaggedField(uid) and
    // elide those input values BEFORE the result leaves this handler
    // (structural redaction; the global scrub() value-scan is the backstop).
    throw new NotImplementedError("snapshot");
  },
});
