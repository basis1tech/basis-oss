// Builds the MCP server: the parse tools (always the Basis API, via
// @basis1/parse) plus the workbook tools from the catalog, run by whichever
// engine the entry point hands in. No I/O happens here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Basis } from "@basis1/parse";
import { registerApiTools } from "./api-tools.ts";
import { MISSING_KEY_MESSAGE, type Config } from "./config.ts";
import { annotationsFor, clientSchemaFor, describeTool, engineTools } from "./engine/catalog.ts";
import type { Engine } from "./engine/engine.ts";
import { withOutputFile } from "./engine/output.ts";

export const SERVER_NAME = "basis";

/** A lazily built API client that refuses clearly when no key is set. */
export function apiClient(config: Pick<Config, "apiKey" | "baseUrl">): () => Basis {
  let client: Basis | undefined;
  return () => {
    if (!config.apiKey) throw Object.assign(new Error(MISSING_KEY_MESSAGE), { code: "missing_api_key" });
    client ??= new Basis({ token: config.apiKey, baseUrl: config.baseUrl });
    return client;
  };
}

export interface ServerDeps {
  version: string;
  engine: Engine;
  basis: () => Basis;
  maxFetchBytes: number;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: deps.version });
  registerApiTools(server, { basis: deps.basis, maxFetchBytes: deps.maxFetchBytes });
  for (const name of deps.engine.tools) {
    server.registerTool(
      name,
      {
        title: engineTools[name].title,
        description: describeTool(name, deps.engine.mode),
        inputSchema: clientSchemaFor(name, deps.engine.mode),
        annotations: annotationsFor(name),
      },
      (args: Record<string, unknown>) => withOutputFile(args, (forward) => deps.engine.call(name, forward)),
    );
  }
  return server;
}
