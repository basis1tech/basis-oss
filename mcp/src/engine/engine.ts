// What the server needs from whichever engine runs the workbook tools. The
// local engine executes them in this process; the hosted engine forwards
// them to the Basis API's MCP endpoint. Choosing one is the only place the
// two differ (see select.ts).
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { EngineMode, EngineToolName } from "./catalog.ts";

export interface Engine {
  readonly mode: EngineMode;
  /** Short human description for the startup line, e.g. "local (basis-napi)". */
  readonly label: string;
  /** The tools this engine offers. */
  readonly tools: readonly EngineToolName[];
  call(name: EngineToolName, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
