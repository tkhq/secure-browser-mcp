/** Print a demo configuration to merge into Hermes; never edit user config. */
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
console.log(`mcp_servers:
  secure-browser:
    command: ${JSON.stringify(process.execPath)}
    args: ["run", ${JSON.stringify(entrypoint)}]
    env:
      TURNKEY_API_PUBLIC_KEY: ""
      TURNKEY_API_PRIVATE_KEY: ""
      TURNKEY_ORGANIZATION_ID: ""
      SBM_HEADLESS: "true"`);
