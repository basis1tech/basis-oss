import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Basis, BasisError, type BasisOptions, type StreamRecord } from "../src/index.ts";
import {
  CELL,
  FakeFetch,
  JOB_ID,
  META,
  TWO_RECORDS,
  errorEnvelope,
  hang,
  jobHandle,
  jobStatus,
  json,
  ndjson,
} from "./fake-fetch.ts";

const TOKEN = "basis_live_test_secret";
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function client(fake: FakeFetch, opts: Partial<BasisOptions> = {}): Basis {
  return new Basis({ token: TOKEN, baseUrl: "https://api.test", pollIntervalMs: 1, fetch: fake.fetch, ...opts });
}

async function rejection(promise: Promise<unknown>): Promise<BasisError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof BasisError, `expected BasisError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the call to reject");
}

describe("construction", () => {
  test("requires an API key", () => {
    assert.throws(() => new Basis({ token: "" }), TypeError);
  });

  test("rejects a non-positive default timeout", () => {
    assert.throws(() => new Basis({ token: TOKEN, timeoutMs: 0 }), RangeError);
  });
});

describe("parse routing", () => {
  test("inline 200: one POST, records returned, auth and content type sent", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
    const records = await client(fake).parse(BYTES);

    assert.deepEqual(records.map((r) => r.type), ["workbook_meta", "cell"]);
    assert.equal(fake.calls.length, 1);
    const [call] = fake.calls;
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, "/v1/jobs");
    assert.equal(call.url.search, "");
    assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(call.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(call.body, BYTES);
  });

  test("202: polls until completed, then fetches the stream", async () => {
    const fake = new FakeFetch().reply(
      jobHandle(),
      jobStatus("processing"),
      jobStatus("processing"),
      jobStatus("completed"),
      ndjson(TWO_RECORDS),
    );
    const records = await client(fake).parse(BYTES);

    assert.equal(records.length, 2);
    assert.deepEqual(
      fake.calls.map((c) => `${c.method} ${c.url.pathname}`),
      [
        "POST /v1/jobs",
        `GET /v1/jobs/${JOB_ID}`,
        `GET /v1/jobs/${JOB_ID}`,
        `GET /v1/jobs/${JOB_ID}`,
        `GET /v1/jobs/${JOB_ID}/stream`,
      ],
    );
  });

  test("a failed job throws with the job's error code", async () => {
    const fake = new FakeFetch().reply(jobHandle(), jobStatus("failed", { code: "worker_timeout", message: "parse did not complete" }));
    const err = await rejection(client(fake).parse(BYTES));
    assert.equal(err.code, "worker_timeout");
    assert.equal(err.message, "parse did not complete");
  });

  test("mode sync and webhookUrl reach the query string", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
    await client(fake).parse(BYTES, { mode: "sync", webhookUrl: "https://hooks.example/basis" });
    const params = fake.calls[0].url.searchParams;
    assert.equal(params.get("mode"), "sync");
    assert.equal(params.get("webhook_url"), "https://hooks.example/basis");
  });

  test("mode job forces the job path and still returns records", async () => {
    const fake = new FakeFetch().reply(jobHandle(), jobStatus("completed"), ndjson(TWO_RECORDS));
    const records = await client(fake).parse(BYTES, { mode: "job" });
    assert.equal(fake.calls[0].url.searchParams.get("mode"), "job");
    assert.equal(records.length, 2);
  });

  test("mode auto sends no mode parameter", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
    await client(fake).parse(BYTES, { mode: "auto" });
    assert.equal(fake.calls[0].url.searchParams.has("mode"), false);
  });

  test("parseRaw returns the NDJSON text unchanged", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
    assert.equal(await client(fake).parseRaw(BYTES), TWO_RECORDS);
  });

  test("submitJob always sends mode=job and returns the handle", async () => {
    const fake = new FakeFetch().reply(jobHandle());
    const job = await client(fake).submitJob(BYTES, { webhookUrl: "https://hooks.example/x" });
    assert.equal(job.job_id, JOB_ID);
    assert.equal(fake.calls[0].url.searchParams.get("mode"), "job");
    assert.equal(fake.calls[0].url.searchParams.get("webhook_url"), "https://hooks.example/x");
  });

  test("submitJob treats a 200 as an invalid response", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
    const err = await rejection(client(fake).submitJob(BYTES));
    assert.equal(err.code, "invalid_response");
    assert.equal(err.status, 200);
  });

  test("diffWorkbooks parses both inputs and diffs locally", async () => {
    const changed = CELL.replace('"num":1', '"num":2');
    const fake = new FakeFetch().reply(ndjson(`${META}\n${sheetRecord()}\n${CELL}\n`), ndjson(`${META}\n${sheetRecord()}\n${changed}\n`));
    const diff = await client(fake).diffWorkbooks(BYTES, BYTES);
    assert.equal(diff.summary.changed, 1);
  });
});

function sheetRecord(): string {
  return '{"type":"sheet","index":0,"title":"S","state":"visible","nrows":1,"ncells":1,"merged":[],"hidden_rows":[],"hidden_cols":[],"comments":[],"data_tables":[]}';
}

describe("inputs", () => {
  test("a path is read from disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "basis-sdk-"));
    try {
      const file = join(dir, "book.xlsx");
      writeFileSync(file, BYTES);
      const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
      await client(fake).parse(file);
      assert.deepEqual(fake.calls[0].body, BYTES);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing path rejects with the filesystem error, not a network error", async () => {
    const fake = new FakeFetch();
    await assert.rejects(client(fake).parse(join(tmpdir(), "basis-sdk-does-not-exist.xlsx")), (err: unknown) => {
      assert.ok(!(err instanceof BasisError));
      assert.equal((err as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
    assert.equal(fake.calls.length, 0);
  });

  test("Blob and ArrayBuffer inputs are sent as-is", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS), ndjson(TWO_RECORDS));
    await client(fake).parse(new Blob([BYTES]));
    await client(fake).parse(BYTES.slice().buffer);
    assert.deepEqual(fake.calls[0].body, BYTES);
    assert.deepEqual(fake.calls[1].body, BYTES);
  });
});

describe("timeouts and abort", () => {
  test("a hung upload times out with code timeout", async () => {
    const fake = new FakeFetch().reply(hang());
    const err = await rejection(client(fake).parse(BYTES, { timeoutMs: 20 }));
    assert.equal(err.code, "timeout");
  });

  test("the timeout covers polling, not just the first request", async () => {
    const fake = new FakeFetch().reply(jobHandle(), ...Array.from({ length: 1000 }, () => jobStatus("processing")));
    const err = await rejection(client(fake, { pollIntervalMs: 5 }).parse(BYTES, { timeoutMs: 40 }));
    assert.equal(err.code, "timeout");
    assert.ok(fake.calls.length > 2, "should have polled at least once");
  });

  test("the client default timeout applies when the call sets none", async () => {
    const fake = new FakeFetch().reply(hang());
    const err = await rejection(client(fake, { timeoutMs: 20 }).queryStream(BYTES));
    assert.equal(err.code, "timeout");
  });

  test("aborting mid-request rejects with code aborted and the reason as cause", async () => {
    const fake = new FakeFetch().reply(hang());
    const controller = new AbortController();
    const pending = client(fake).getJob(JOB_ID, { signal: controller.signal });
    const reason = new Error("user navigated away");
    setTimeout(() => controller.abort(reason), 5);
    const err = await rejection(pending);
    assert.equal(err.code, "aborted");
    assert.equal(err.cause, reason);
  });

  test("an already-aborted signal makes no request", async () => {
    const fake = new FakeFetch();
    const err = await rejection(client(fake).parse(BYTES, { signal: AbortSignal.abort() }));
    assert.equal(err.code, "aborted");
    assert.equal(fake.calls.length, 0);
  });

  test("aborting while waiting between polls stops promptly", async () => {
    const fake = new FakeFetch().reply(jobHandle(), jobStatus("processing"));
    const controller = new AbortController();
    const pending = client(fake, { pollIntervalMs: 60_000 }).parse(BYTES, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const started = Date.now();
    const err = await rejection(pending);
    assert.equal(err.code, "aborted");
    assert.ok(Date.now() - started < 5_000);
  });

  test("Infinity disables the timeout", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
    assert.equal((await client(fake).parse(BYTES, { timeoutMs: Infinity })).length, 2);
  });
});

describe("job reads", () => {
  test("streamJob and jobRecords pass since", async () => {
    const fake = new FakeFetch().reply(ndjson(CELL + "\n"), ndjson(CELL + "\n"));
    const c = client(fake);
    await c.streamJob(JOB_ID, 5);
    const records: StreamRecord[] = [];
    for await (const r of c.jobRecords(JOB_ID, { since: 7 })) records.push(r);
    assert.equal(fake.calls[0].url.pathname, `/v1/jobs/${JOB_ID}/stream`);
    assert.equal(fake.calls[0].url.searchParams.get("since"), "5");
    assert.equal(fake.calls[1].url.searchParams.get("since"), "7");
    assert.equal(records.length, 1);
  });

  test("streamJob without since sends no since parameter", async () => {
    const fake = new FakeFetch().reply(ndjson(""));
    await client(fake).streamJob(JOB_ID);
    assert.equal(fake.calls[0].url.search, "");
  });

  test("per-sheet routes use the sheet index and since", async () => {
    const fake = new FakeFetch().reply(json(200, []), ndjson(""), ndjson(""));
    const c = client(fake);
    await c.listJobSheets(JOB_ID);
    await c.streamJobSheet(JOB_ID, 2, 3);
    for await (const _ of c.jobSheetRecords(JOB_ID, 4, { since: 0 })) assert.fail("no records expected");
    assert.equal(fake.calls[0].url.pathname, `/v1/jobs/${JOB_ID}/sheets`);
    assert.equal(fake.calls[1].url.pathname, `/v1/jobs/${JOB_ID}/sheets/2/stream`);
    assert.equal(fake.calls[1].url.searchParams.get("since"), "3");
    assert.equal(fake.calls[2].url.pathname, `/v1/jobs/${JOB_ID}/sheets/4/stream`);
    assert.equal(fake.calls[2].url.searchParams.get("since"), "0");
  });

  test("invalid since and sheet index are rejected before any request", async () => {
    const fake = new FakeFetch();
    const c = client(fake);
    await assert.rejects(c.streamJob(JOB_ID, -1), TypeError);
    await assert.rejects(c.streamJob(JOB_ID, 1.5), TypeError);
    await assert.rejects(c.streamJobSheet(JOB_ID, -1), TypeError);
    assert.equal(fake.calls.length, 0);
  });

  test("job ids are percent-encoded in the path", async () => {
    const fake = new FakeFetch().reply(jobStatus("processing"));
    await client(fake).getJob("a/b?c#d");
    assert.ok(fake.calls[0].url.href.endsWith("/v1/jobs/a%2Fb%3Fc%23d"), fake.calls[0].url.href);
  });

  test("an empty job id is rejected", async () => {
    await assert.rejects(client(new FakeFetch()).getJob(""), TypeError);
  });
});

describe("error mapping", () => {
  test("the envelope's code, message and status are kept", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(401, "unauthorized", "missing or invalid bearer token"));
    const err = await rejection(client(fake).getJob(JOB_ID));
    assert.equal(err.code, "unauthorized");
    assert.equal(err.serverCode, "unauthorized");
    assert.equal(err.status, 401);
    assert.equal(err.message, "missing or invalid bearer token");
  });

  test("402 exposes the quota headers", async () => {
    const fake = new FakeFetch().reply(
      errorEnvelope(402, "quota_exceeded", "quota exceeded for requests", {
        "x-basis-quota-limit": "1000",
        "x-basis-quota-used": "1000",
        "x-basis-quota-reset": "2026-12-01T00:00:00.000Z",
      }),
    );
    const err = await rejection(client(fake).parse(BYTES));
    assert.equal(err.code, "quota_exceeded");
    assert.deepEqual(err.quota, { limit: 1000, used: 1000, resetAt: "2026-12-01T00:00:00.000Z" });
  });

  test("402 exposes the exhausted dimension when the server sends it", async () => {
    const fake = new FakeFetch().reply(
      errorEnvelope(402, "quota_exceeded", "quota exceeded for cells_out", {
        "x-basis-quota-dimension": "cells_out",
        "x-basis-quota-limit": "50000000",
        "x-basis-quota-used": "50000000",
        "x-basis-quota-reset": "2026-12-01T00:00:00.000Z",
      }),
    );
    const err = await rejection(client(fake).parse(BYTES));
    assert.equal(err.quota?.dimension, "cells_out");
  });

  test("402 without quota headers leaves quota undefined", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(402, "quota_exceeded", "quota exceeded"));
    assert.equal((await rejection(client(fake).parse(BYTES))).quota, undefined);
  });

  test("429 exposes retryAfter in seconds", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(429, "rate_limited", "too many requests; retry later", { "retry-after": "7" }));
    const err = await rejection(client(fake).parse(BYTES));
    assert.equal(err.code, "rate_limited");
    assert.equal(err.retryAfter, 7);
  });

  test("an unknown server code becomes unknown, with serverCode kept", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(418, "teapot", "short and stout"));
    const err = await rejection(client(fake).getJob(JOB_ID));
    assert.equal(err.code, "unknown");
    assert.equal(err.serverCode, "teapot");
  });

  test("a non-JSON error body is invalid_response with the status", async () => {
    const fake = new FakeFetch().reply(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await rejection(client(fake).getJob(JOB_ID));
    assert.equal(err.code, "invalid_response");
    assert.equal(err.status, 502);
  });

  test("a fetch failure is network_error with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const fake = new FakeFetch().reply(() => {
      throw cause;
    });
    const err = await rejection(client(fake).getJob(JOB_ID));
    assert.equal(err.code, "network_error");
    assert.equal(err.cause, cause);
  });

  test("a 2xx JSON route with a non-JSON body is invalid_response", async () => {
    const fake = new FakeFetch().reply(() => new Response("not json", { status: 200 }));
    assert.equal((await rejection(client(fake).getJob(JOB_ID))).code, "invalid_response");
  });
});

describe("retries", () => {
  test("off by default: a GET 429 is not retried", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(429, "rate_limited", "slow down", { "retry-after": "0" }));
    await rejection(client(fake).getJob(JOB_ID));
    assert.equal(fake.calls.length, 1);
  });

  test("opt-in: GETs retry on 429 and 503, honouring Retry-After", async () => {
    const fake = new FakeFetch().reply(
      errorEnvelope(429, "rate_limited", "slow down", { "retry-after": "0" }),
      errorEnvelope(503, "unavailable", "try later"),
      jobStatus("completed"),
    );
    const status = await client(fake, { retry: { maxRetries: 2, maxDelayMs: 5 } }).getJob(JOB_ID);
    assert.equal(status.status, "completed");
    assert.equal(fake.calls.length, 3);
  });

  test("opt-in: gives up after maxRetries", async () => {
    const fake = new FakeFetch().reply(
      errorEnvelope(429, "rate_limited", "slow down", { "retry-after": "0" }),
      errorEnvelope(429, "rate_limited", "slow down", { "retry-after": "0" }),
    );
    const err = await rejection(client(fake, { retry: { maxRetries: 1 } }).getJob(JOB_ID));
    assert.equal(err.code, "rate_limited");
    assert.equal(fake.calls.length, 2);
  });

  test("opt-in: a Retry-After longer than maxDelayMs is not waited out", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(429, "rate_limited", "slow down", { "retry-after": "60" }));
    const err = await rejection(client(fake, { retry: { maxRetries: 3, maxDelayMs: 1_000 } }).getJob(JOB_ID));
    assert.equal(err.retryAfter, 60);
    assert.equal(fake.calls.length, 1);
  });

  test("uploads are never retried, even with retries on", async () => {
    const limited = errorEnvelope(429, "rate_limited", "slow down", { "retry-after": "0" });
    const fake = new FakeFetch().reply(limited, limited, limited);
    const c = client(fake, { retry: { maxRetries: 5 } });
    await rejection(c.parse(BYTES));
    await rejection(c.saveToLibrary(BYTES));
    await rejection(c.queryStream(BYTES));
    assert.deepEqual(fake.calls.map((x) => x.method), ["POST", "POST", "QUERY"]);
  });

  test("non-transient errors are not retried", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(404, "not_found", "no such job"));
    await rejection(client(fake, { retry: { maxRetries: 3 } }).getJob(JOB_ID));
    assert.equal(fake.calls.length, 1);
  });
});

describe("other routes", () => {
  test("queryStream sends QUERY to /api/v1/stream", async () => {
    const fake = new FakeFetch().reply(ndjson(TWO_RECORDS));
    assert.equal(await client(fake).queryStream(BYTES), TWO_RECORDS);
    assert.equal(fake.calls[0].method, "QUERY");
    assert.equal(fake.calls[0].url.pathname, "/api/v1/stream");
    assert.equal(fake.calls[0].headers.get("content-type"), "application/octet-stream");
  });

  test("saveToLibrary sends its options as query parameters and returns the result", async () => {
    const result = { library_file_id: "f1", version_id: "v2", name: "Model", message: "Q3 close", created: false, noop: false };
    const fake = new FakeFetch().reply(json(201, result));
    const saved = await client(fake).saveToLibrary(BYTES, { name: "Model", fileId: "f1", sessionId: "s9", message: "Q3 close" });
    assert.deepEqual(saved, result);
    const call = fake.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, "/v1/library/save");
    assert.deepEqual(Object.fromEntries(call.url.searchParams), { name: "Model", file_id: "f1", session_id: "s9", message: "Q3 close" });
  });

  test("saveToLibrary without options sends no query string", async () => {
    const fake = new FakeFetch().reply(json(200, { library_file_id: "f", version_id: "v", name: "Untitled", message: "import", created: true, noop: true }));
    await client(fake).saveToLibrary(BYTES);
    assert.equal(fake.calls[0].url.search, "");
  });

  test("saveToLibrary maps library errors", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(502, "library_error", "upstream failed"));
    assert.equal((await rejection(client(fake).saveToLibrary(BYTES))).code, "library_error");
  });

  const SUMMARY = {
    ok: false,
    formula_cells: 2,
    macro_enabled: false,
    error_total: 1,
    error_counts: { "#DIV/0!": 1 },
    errors: [{ sheet: "Data", cell: "D4", error: "#DIV/0!", formula: "=1/0" }],
    uncomputed_total: 0,
    uncomputed: [],
    warnings: [],
  };
  const EXPORTED = {
    filename: "agent.xlsx",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: 4,
    file_base64: Buffer.from(BYTES).toString("base64"),
    summary: SUMMARY,
  };

  test("recalc posts the file and decodes the returned workbook and summary", async () => {
    const fake = new FakeFetch().reply(json(200, EXPORTED));
    const out = await client(fake).recalc(BYTES, { filename: "agent" });
    const call = fake.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url.pathname, "/v1/recalc");
    assert.deepEqual(Object.fromEntries(call.url.searchParams), { format: "json", filename: "agent" });
    assert.deepEqual([...out.bytes], [...BYTES]);
    assert.equal(out.filename, "agent.xlsx");
    assert.equal(out.summary.errors[0].cell, "D4");
  });

  test("recalc is never retried and maps API errors", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(413, "payload_too_large", "too big"), json(200, EXPORTED));
    const c = client(fake, { retry: { maxRetries: 3 } });
    assert.equal((await rejection(c.recalc(BYTES))).code, "payload_too_large");
    assert.equal(fake.calls.length, 1);
  });

  test("exportSession GETs the session's export as JSON", async () => {
    const fake = new FakeFetch().reply(json(200, EXPORTED));
    const out = await client(fake).exportSession("s 1");
    const call = fake.calls[0];
    assert.equal(call.method, "GET");
    assert.equal(call.url.pathname, "/v1/sessions/s%201/export");
    assert.equal(call.url.searchParams.get("format"), "json");
    assert.equal(out.summary.error_total, 1);
  });

  test("exportSession reports an unknown session and rejects an empty id", async () => {
    const fake = new FakeFetch().reply(errorEnvelope(404, "session_not_found", "session not found or expired"));
    assert.equal((await rejection(client(fake).exportSession("gone"))).code, "session_not_found");
    await assert.rejects(client(fake).exportSession(""), TypeError);
  });

  test("healthz resolves true on 200", async () => {
    const fake = new FakeFetch().reply(() => new Response("ok", { status: 200 }));
    assert.equal(await client(fake).healthz(), true);
    assert.equal(fake.calls[0].url.pathname, "/healthz");
  });

  test("a trailing slash on baseUrl is ignored", async () => {
    const fake = new FakeFetch().reply(() => new Response("ok"));
    await client(fake, { baseUrl: "https://api.test/" }).healthz();
    assert.equal(fake.calls[0].url.href, "https://api.test/healthz");
  });
});
