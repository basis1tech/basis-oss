import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Basis, BasisError, parseNdjson, readNdjson, type StreamRecord } from "../src/index.ts";
import { CELL, FakeFetch, META, chunked } from "./fake-fetch.ts";

const encoder = new TextEncoder();

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** Splits bytes at every given offset. */
function splitAt(bytes: Uint8Array, offsets: number[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (const end of offsets) {
    out.push(bytes.slice(start, end));
    start = end;
  }
  out.push(bytes.slice(start));
  return out;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamRecord[]> {
  const out: StreamRecord[] = [];
  for await (const r of readNdjson(stream)) out.push(r);
  return out;
}

describe("readNdjson", () => {
  test("reassembles records split at every possible byte offset", async () => {
    // A string with multi-byte UTF-8 (é is 2 bytes, 💰 is 4) so some splits
    // land inside a character, not just inside a JSON token.
    const cell = CELL.replace('"str":null', '"str":"café 💰"');
    const bytes = encoder.encode(`${META}\n${cell}\n`);
    for (let cut = 1; cut < bytes.length; cut++) {
      const records = await collect(streamOf(splitAt(bytes, [cut])));
      assert.equal(records.length, 2, `split at byte ${cut}`);
      const second = records[1];
      assert.ok(second.type === "cell");
      assert.equal(second.str, "café 💰", `split at byte ${cut}`);
    }
  });

  test("handles one byte per chunk", async () => {
    const bytes = encoder.encode(`${META}\n${CELL}\n`);
    const chunks = Array.from(bytes, (b) => new Uint8Array([b]));
    assert.equal((await collect(streamOf(chunks))).length, 2);
  });

  test("handles many records in one chunk, a final line without newline, CRLF and blank lines", async () => {
    const bytes = encoder.encode(`${META}\r\n\n${CELL}\n${CELL}`);
    assert.deepEqual((await collect(streamOf([bytes]))).map((r) => r.type), ["workbook_meta", "cell", "cell"]);
  });

  test("an empty body yields nothing", async () => {
    assert.equal((await collect(streamOf([]))).length, 0);
  });

  test("breaking out early cancels the stream", async () => {
    let cancelled = false;
    const lines = Array.from({ length: 50 }, () => encoder.encode(`${CELL}\n`));
    for await (const _ of readNdjson(streamOf(lines, () => (cancelled = true)))) break;
    assert.equal(cancelled, true);
  });

  test("a malformed line is invalid_response with its line number", async () => {
    const bytes = encoder.encode(`${META}\n{not json\n`);
    await assert.rejects(collect(streamOf([bytes])), (err: unknown) => {
      assert.ok(err instanceof BasisError);
      assert.equal(err.code, "invalid_response");
      assert.match(err.message, /line 2/);
      return true;
    });
  });
});

describe("parseNdjson", () => {
  test("matches readNdjson on the same text", async () => {
    const text = `${META}\n${CELL}\n`;
    assert.deepEqual(parseNdjson(text), await collect(streamOf([encoder.encode(text)])));
  });
});

describe("parseStream", () => {
  test("yields records from a chunked response, across chunk boundaries", async () => {
    const bytes = encoder.encode(`${META}\n${CELL}\n${CELL}\n`);
    const fake = new FakeFetch().reply(chunked(splitAt(bytes, [10, 200, 201, 230])));
    const basis = new Basis({ token: "k", baseUrl: "https://api.test", fetch: fake.fetch });
    const types: string[] = [];
    for await (const r of basis.parseStream(new Uint8Array([1]))) types.push(r.type);
    assert.deepEqual(types, ["workbook_meta", "cell", "cell"]);
  });

  test("does not send anything until iterated", async () => {
    const fake = new FakeFetch();
    const basis = new Basis({ token: "k", baseUrl: "https://api.test", fetch: fake.fetch });
    basis.parseStream(new Uint8Array([1]));
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(fake.calls.length, 0);
  });

  test("a timeout while reading the body becomes code timeout", async () => {
    const fake = new FakeFetch().reply((call) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`${META}\n`));
          call.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(stream);
    });
    const basis = new Basis({ token: "k", baseUrl: "https://api.test", fetch: fake.fetch });
    const seen: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const r of basis.parseStream(new Uint8Array([1]), { timeoutMs: 30 })) seen.push(r.type);
      })(),
      (err: unknown) => err instanceof BasisError && err.code === "timeout",
    );
    assert.deepEqual(seen, ["workbook_meta"]);
  });
});
