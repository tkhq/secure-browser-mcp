import { defineTool, NotImplementedError } from "./tool.js";

export const listNetwork = defineTool({
  name: "list_network_requests",
  description:
    "List network requests made by the current page (method, URL, status). " +
    "Request bodies are withheld for origins with live secrets.",
  inputSchema: {},
  handler: async (_ctx) => {
    // Metadata only by default; body access is the classic exfiltration
    // channel for filled secrets, so bodies stay behind structural redaction.
    throw new NotImplementedError("list_network_requests");
  },
});
