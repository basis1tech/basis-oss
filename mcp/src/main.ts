// Shared process wiring for the stdio entry points: argument handling,
// configuration, the startup line and shutdown. stdout carries the MCP
// protocol once the server starts, so every diagnostic goes to stderr, and
// the API key is never printed.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Basis } from "@basis1/parse";
import { API_TOOL_NAMES } from "./api-tools.ts";
import { loadConfig, type Config } from "./config.ts";
import type { Engine } from "./engine/engine.ts";
import { apiClient, createServer } from "./server.ts";

declare const __BASIS_MCP_VERSION__: string | undefined;

export const VERSION = typeof __BASIS_MCP_VERSION__ === "string" ? __BASIS_MCP_VERSION__ : "0.0.0-dev";

const HELP = `basis-mcp ${VERSION}: MCP server for Basis (xlsx parsing, formula evaluation, workbook sessions)

Usage: npx -y @basis1/mcp      (speaks MCP over stdio; start it from an MCP client)

Environment:
  BASIS_API_KEY              Your Basis API key (required for every tool)
  BASIS_BASE_URL             API base URL (default https://api.basis1.tech)
  BASIS_MCP_MAX_FETCH_BYTES  Size limit when a tool fetches a workbook from a URL (default 200000000)

Every tool runs on the Basis API: workbooks you pass are uploaded to it.
Docs: https://github.com/basis1-tech/basis-oss/tree/main/mcp#readme
`;

export function log(level: "info" | "warn" | "error", message: string): void {
  process.stderr.write(`basis-mcp ${level}: ${message}\n`);
}

/** Handles --help/--version. Returns true when the process should exit. */
function handleArgs(argv: readonly string[]): boolean {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return true;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return true;
  }
  const unknown = argv.filter((a) => a.startsWith("-"));
  if (unknown.length > 0) {
    log("error", `unknown option ${unknown.join(" ")}. This server takes its settings from environment variables; run with --help.`);
    process.exitCode = 2;
    return true;
  }
  return false;
}

export interface MainDeps {
  makeEngine: (config: Config, basis: () => Basis) => Promise<Engine>;
}

export async function main(deps: MainDeps): Promise<void> {
  if (handleArgs(process.argv.slice(2))) return;

  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    for (const e of loaded.errors) log("error", e);
    log("error", "not starting. Fix the settings above in this server's env (your MCP client config).");
    process.exitCode = 1;
    return;
  }
  const { config } = loaded;
  for (const w of config.warnings) log("warn", w);

  const basis = apiClient(config);
  let engine: Engine;
  try {
    engine = await deps.makeEngine(config, basis);
  } catch (err) {
    log("error", `not starting: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const server = createServer({ version: VERSION, engine, basis, maxFetchBytes: config.maxFetchBytes });
  const transport = new StdioServerTransport();
  const shutdown = () => {
    void engine.close().finally(() => server.close());
  };
  process.stdin.on("end", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await server.connect(transport);
  log("info", `${VERSION} ready: ${engine.tools.length + API_TOOL_NAMES.length} tools; workbook tools run on ${engine.label}; API ${config.baseUrl}.`);
  if (!config.apiKey) {
    log("warn", "BASIS_API_KEY is not set, so every tool will return an error until you add it to this server's env.");
  }
}
