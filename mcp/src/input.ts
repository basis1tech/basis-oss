// Shared input resolution: exactly one of path/url/base64 becomes workbook
// bytes. Callers check the one-of constraint before calling.
import { readFile } from "node:fs/promises";

export interface WorkbookInput {
  path?: string;
  url?: string;
  base64?: string;
}

export function countInputs(args: WorkbookInput): number {
  return [args.path, args.url, args.base64].filter((v) => v !== undefined).length;
}

async function fetchUrl(url: string, limit: number): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetching ${url} failed: ${res.status} ${res.statusText}`);
  }
  const len = res.headers.get("content-length");
  if (len && Number(len) > limit) {
    throw new Error(`${url} is ${len} bytes, exceeding BASIS_MCP_MAX_FETCH_BYTES (${limit})`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > limit) {
    throw new Error(`${url} is ${buf.byteLength} bytes, exceeding BASIS_MCP_MAX_FETCH_BYTES (${limit})`);
  }
  return buf;
}

export async function resolveBytes(input: WorkbookInput, maxFetchBytes: number): Promise<Uint8Array> {
  if (input.path !== undefined) return new Uint8Array(await readFile(input.path));
  if (input.base64 !== undefined) return new Uint8Array(Buffer.from(input.base64, "base64"));
  if (input.url !== undefined) return await fetchUrl(input.url, maxFetchBytes);
  throw new Error("one of path, url, or base64 is required");
}
