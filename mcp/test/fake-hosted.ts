// A stand-in for the hosted Basis API's MCP endpoint (server/index.js,
// POST /mcp): stateless Streamable HTTP, bearer auth, one McpServer per
// request. Each tool echoes the arguments it received so tests can check
// what the stdio bridge forwarded.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { inputSchemaFor, toolsFor } from "../src/engine/catalog.ts";

export interface FakeHosted {
  url: string;
  /** Authorization headers seen, in order. */
  authHeaders: string[];
  close(): Promise<void>;
}

export const GOOD_KEY = "basis_test_key_do_not_log_7f3a";

export async function startFakeHosted(): Promise<FakeHosted> {
  const authHeaders: string[] = [];
  const server: Server = createServer((req, res) => {
    if (req.url !== "/mcp" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers.authorization ?? "";
    authHeaders.push(auth);
    if (auth !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"code":"unauthorized"}}');
      return;
    }
    const mcp = new McpServer({ name: "fake-hosted", version: "0.0.0" });
    for (const name of toolsFor("hosted")) {
      mcp.registerTool(name, { inputSchema: inputSchemaFor(name, "hosted") }, async (args: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ tool: name, args }) }],
      }));
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    mcp.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    authHeaders,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
