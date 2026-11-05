// NDJSON framing shared by every record-returning call. Records are one JSON
// object per `\n`-terminated line (core/src/stream.rs writes them that way);
// a final line without a trailing newline is still a record. The streaming
// reader decodes incrementally, so a multi-byte UTF-8 character or a record
// split across network chunks is reassembled before parsing, and only one
// partial line is ever held in memory.
import { BasisError } from "./errors.ts";
import type { StreamRecord } from "./types.ts";

function parseLine(line: string, lineNo: number): StreamRecord {
  try {
    return JSON.parse(line) as StreamRecord;
  } catch (err) {
    throw new BasisError(`NDJSON line ${lineNo} is not valid JSON`, "invalid_response", { cause: err });
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Splits a complete NDJSON document into records. Blank lines are skipped. */
export function parseNdjson(ndjson: string): StreamRecord[] {
  const out: StreamRecord[] = [];
  let lineNo = 0;
  for (const raw of ndjson.split("\n")) {
    lineNo++;
    const line = stripCr(raw);
    if (line.length > 0) out.push(parseLine(line, lineNo));
  }
  return out;
}

/**
 * Yields records from an NDJSON byte stream as they arrive, without buffering
 * the whole body. Breaking out of the loop cancels the underlying stream.
 */
export async function* readNdjson(stream: ReadableStream<Uint8Array>): AsyncGenerator<StreamRecord, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let lineNo = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let start = 0;
      let nl = pending.indexOf("\n", start);
      while (nl !== -1) {
        lineNo++;
        const line = stripCr(pending.slice(start, nl));
        start = nl + 1;
        if (line.length > 0) yield parseLine(line, lineNo);
        nl = pending.indexOf("\n", start);
      }
      pending = pending.slice(start);
    }
    pending += decoder.decode();
    finished = true;
    const last = stripCr(pending);
    if (last.length > 0) yield parseLine(last, lineNo + 1);
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
