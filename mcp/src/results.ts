// Tool-result shapes shared by every tool: JSON text on success, and a
// structured `{code, message, status}` payload with isError on failure, so a
// client sees a tool error rather than a transport failure.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BasisError } from "@basis1/parse";

export function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** A domain error with a stable code, for failures that aren't BasisErrors. */
export interface CodedError {
  code: string;
  message: string;
}

export function errorResult(err: unknown): CallToolResult {
  let payload: { code: string; message: string; status: number | null };
  if (err instanceof BasisError) {
    payload = { code: err.code ?? "unknown", message: err.message, status: err.status ?? null };
  } else if (err instanceof Error) {
    // Errors may carry a code (ours, e.g. missing_api_key, or Node's, e.g. ENOENT).
    const code = (err as { code?: unknown }).code;
    payload = { code: typeof code === "string" ? code : "unknown", message: err.message, status: null };
  } else if (isCoded(err)) {
    payload = { code: err.code, message: err.message, status: null };
  } else {
    payload = { code: "unknown", message: String(err), status: null };
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function isCoded(err: unknown): err is CodedError {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as CodedError).code === "string" &&
    typeof (err as CodedError).message === "string"
  );
}
