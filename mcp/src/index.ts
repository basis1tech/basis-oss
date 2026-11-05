// The published entry point (`npx -y @basis1/mcp`). Thin client: every tool
// runs on the Basis API. Parse tools call its REST API through @basis1/parse;
// workbook tools are forwarded to its MCP endpoint. No engine ships in this
// package.
import { createHostedEngine } from "./engine/hosted.ts";
import { main, VERSION } from "./main.ts";

await main({
  makeEngine: async (config) => createHostedEngine({ mcpUrl: config.mcpUrl, apiKey: config.apiKey, version: VERSION }),
});
