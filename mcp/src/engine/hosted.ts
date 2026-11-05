// The hosted engine: forwards each workbook tool call to the Basis API's MCP
// endpoint (server/index.js, POST /mcp) and returns its result unchanged.
// Sessions live on the server, scoped to the API key. The only translation is
// `path`: the hosted endpoint can't read this machine's files, so the file is
// read here and sent as `base64`.
//
// Nothing connects until the first call, so the server starts (and answers
// tools/list) without a network or an API key.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { MISSING_KEY_MESSAGE } from "../config.ts";
import { errorResult } from "../results.ts";
import { toolsFor, type EngineToolName } from "./catalog.ts";
import type { Engine } from "./engine.ts";

export interface HostedEngineDeps {
  mcpUrl: string;
  apiKey: string | undefined;
  version: string;
  /** Per-call timeout; opening a large workbook takes a while. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/** Replaces a local `path` with the file's bytes as `base64`. */
export async function withUploadedPath(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof args.path !== "string") return args;
  if (args.base64 !== undefined || args.url !== undefined || args.library_file_id !== undefined) {
    throw new Error("provide at most one of path, base64, url, or library_file_id");
  }
  const { path, ...rest } = args;
  const bytes = await readFile(path);
  return { ...rest, base64: bytes.toString("base64") };
}

function transportError(err: unknown, mcpUrl: string): CallToolResult {
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
    return errorResult({ code: "unauthorized", message: "The Basis API rejected the API key. Check BASIS_API_KEY." });
  }
  if (err instanceof StreamableHTTPError && err.code === 429) {
    return errorResult({ code: "rate_limited", message: "The Basis API is rate limiting this key. Try again shortly." });
  }
  if (err instanceof StreamableHTTPError) {
    return errorResult({ code: "hosted_error", message: `The Basis API answered ${err.code ?? "an error"} at ${mcpUrl}: ${err.message}` });
  }
  if (err instanceof TypeError) {
    return errorResult({ code: "network_error", message: `Couldn't reach the Basis API at ${mcpUrl}: ${err.message}` });
  }
  return errorResult(err);
}

export function createHostedEngine(deps: HostedEngineDeps): Engine {
  let client: Promise<Client> | undefined;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function connect(apiKey: string): Promise<Client> {
    const c = new Client({ name: "basis-mcp-stdio-bridge", version: deps.version });
    const transport = new StreamableHTTPClientTransport(new URL(deps.mcpUrl), {
      requestInit: {
        headers: { authorization: `Bearer ${apiKey}`, "user-agent": `basis-mcp/${deps.version}` },
      },
    });
    return c.connect(transport, { timeout }).then(() => c);
  }

  return {
    mode: "hosted",
    label: `hosted (${deps.mcpUrl})`,
    tools: toolsFor("hosted"),
    async call(name: EngineToolName, args: Record<string, unknown>): Promise<CallToolResult> {
      if (!deps.apiKey) return errorResult({ code: "missing_api_key", message: MISSING_KEY_MESSAGE });
      let forwarded: Record<string, unknown>;
      try {
        forwarded = await withUploadedPath(args);
      } catch (err) {
        return errorResult(err);
      }
      try {
        client ??= connect(deps.apiKey);
        const c = await client;
        return (await c.callTool({ name, arguments: forwarded }, undefined, { timeout })) as CallToolResult;
      } catch (err) {
        // Drop the connection so the next call starts fresh (the endpoint is
        // stateless, so nothing is lost).
        const stale = client;
        client = undefined;
        stale?.then((c) => c.close()).catch(() => {});
        return transportError(err, deps.mcpUrl);
      }
    },
    async close() {
      const c = client;
      client = undefined;
      await c?.then((x) => x.close()).catch(() => {});
    },
  };
}
