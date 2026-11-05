# @basis1/parse

**The Excel engine for AI agents.** Let AI agents read, check and edit Excel models.

TypeScript client for the [Basis](https://api.basis1.tech/docs) xlsx parsing
API. Send a workbook, get typed records back: cells, formulas, the formula
dependency graph, embedded images and an audit of the model.

```ts
import { Basis } from "@basis1/parse";

const basis = new Basis({ token: process.env.BASIS_API_KEY! });
const records = await basis.parse("./workbook.xlsx");
```

Small files come back in one round trip. Large or slow ones are submitted as
a job and polled to completion for you; `parse()` looks the same either way.

## Install

`@basis1/parse` is published on npm (0.1.0):

```sh
npm i @basis1/parse
```

You need an API key, which you create yourself in your account settings at
[basis1.tech/settings](https://basis1.tech/settings).

No runtime dependencies. ESM, with type declarations. Tested on Node 20.19
or later, from ES modules and from CommonJS via `require()`. It uses only
web-standard APIs otherwise, so it's built to run in edge runtimes and
browsers too (see [Browsers and edge runtimes](#browsers-and-edge-runtimes)).

## Quickstart

```ts
import { Basis, BasisError } from "@basis1/parse";

const basis = new Basis({ token: process.env.BASIS_API_KEY! });

try {
  for await (const record of basis.parseStream("./model.xlsx")) {
    if (record.type === "cell" && record.formula) console.log(record.ref, record.formula);
    if (record.type === "audit" && record.finding === "plug_summary") {
      console.log("plugs:", record.total, record.by_kind);
    }
  }
} catch (err) {
  if (err instanceof BasisError && err.code === "quota_exceeded") {
    console.error(`Quota used up until ${err.quota?.resetAt}`);
  } else {
    throw err;
  }
}
```

## Client options

```ts
const basis = new Basis({
  token: "basis_live_…",                // required: your API key
  baseUrl: "https://api.basis1.tech",   // optional
  timeoutMs: 120_000,                   // optional: default limit for every call; Infinity disables
  pollIntervalMs: 500,                  // optional: job status poll cadence inside parse()
  retry: { maxRetries: 2 },             // optional: retry GETs on 429/503/network errors (off by default)
  fetch: customFetch,                   // optional: your own fetch implementation
});
```

`token` is your per-customer API key (`basis_live_<id>_<secret>`). Keep it on
the server; don't ship it to a browser.

## Inputs

Every upload method takes a `FileInput`:

| Input | Notes |
| --- | --- |
| `Uint8Array` (including Node's `Buffer`) | Sent as is. |
| `ArrayBuffer` | Sent as is. |
| `Blob` / `File` | Sent as is, streamed by the runtime. |
| `string` | A file path. Node, Bun and Deno only. Streamed from disk, not read into memory. |

## Methods

Every method accepts `signal` and `timeoutMs` in its options (see
[Timeouts and cancelling](#timeouts-and-cancelling)).

| Method | Returns | HTTP |
| --- | --- | --- |
| `parse(input, { mode?, webhookUrl? })` | `StreamRecord[]` | `POST /v1/jobs`, then polling if the server answers 202 |
| `parseStream(input, { mode?, webhookUrl? })` | `AsyncGenerator<StreamRecord>` | same as `parse` |
| `parseRaw(input, { mode?, webhookUrl? })` | NDJSON `string` | same as `parse` |
| `queryStream(input)` | NDJSON `string` | `QUERY /api/v1/stream` |
| `submitJob(input, { webhookUrl? })` | `Job` | `POST /v1/jobs?mode=job` |
| `getJob(jobId)` | `JobStatus` | `GET /v1/jobs/{id}` |
| `streamJob(jobId, since?)` | NDJSON `string` | `GET /v1/jobs/{id}/stream` |
| `jobRecords(jobId, { since? })` | `AsyncGenerator<StreamRecord>` | `GET /v1/jobs/{id}/stream` |
| `listJobSheets(jobId)` | `SheetInfo[]` | `GET /v1/jobs/{id}/sheets` |
| `streamJobSheet(jobId, index, since?)` | NDJSON `string` | `GET /v1/jobs/{id}/sheets/{index}/stream` |
| `jobSheetRecords(jobId, index, { since? })` | `AsyncGenerator<StreamRecord>` | same |
| `saveToLibrary(input, { name?, fileId?, message?, sessionId? })` | `LibrarySaveResult` | `POST /v1/library/save` |
| `recalc(input, { filename? })` | `ExportedWorkbook` | `POST /v1/recalc?format=json` |
| `exportSession(sessionId)` | `ExportedWorkbook` | `GET /v1/sessions/{id}/export?format=json` |
| `diffWorkbooks(before, after, { includeFormat? })` | `WorkbookDiff` | two `parse` calls, diffed locally |
| `healthz()` | `true` | `GET /healthz` |

Standalone functions: `diffRecords(before, after)` diffs records you already
have; `readNdjson(stream)` and `parseNdjson(text)` decode NDJSON yourself;
`verifyWebhookSignature(...)` is described [below](#webhooks).

### parse, parseStream, parseRaw

`mode` picks how the server answers:

- `"auto"` (default): inline for small, fast files; a job for the rest. The
  SDK polls the job for you.
- `"sync"`: always inline, however long the parse takes. Pair it with a
  `timeoutMs` that allows for that.
- `"job"`: always a job, polled for you.

`webhookUrl` asks the server to POST a signed notification when a job
finishes (see [Webhooks](#webhooks)).

### Jobs

Use `submitJob()` when you want a handle to come back to later, for example
from a queue worker, instead of waiting inside `parse()`:

```ts
const job = await basis.submitJob(bytes, { webhookUrl: "https://example.com/hooks/basis" });
// later
const status = await basis.getJob(job.job_id);
if (status.status === "completed") {
  for await (const record of basis.jobRecords(job.job_id)) handle(record);
}
```

`since` is a record index: pass the number of records you already have to
fetch only the rest. Per-sheet streams (`streamJobSheet`, `jobSheetRecords`)
contain only that sheet's `sheet`, `cell` and `image` records, and their
`since` counts within that sheet. Jobs expire 15 minutes after creation by
default.

### saveToLibrary

Saves a workbook to the Library of the user who owns the API key, as a new
file or, with `fileId`, a new version of an existing one. Needs a per-user key.
Returns a `LibrarySaveResult` (`library_file_id`, `version_id`, `name`,
`message`, `created`, `noop`); `noop` is `true` when nothing changed. The
call is never retried by the SDK.

`sessionId` saves a workbook session held by the Basis server instead of
`input`. Those sessions are created only through the hosted MCP endpoint
today, so most SDK users won't have one.

### recalc and exportSession

A workbook written by openpyxl (or any library that saves formulas without
results) has no computed values in it, so pandas and `data_only` readers see
empty cells. `recalc()` sends the file and returns it with every formula's
value saved, the same drop-in role as running LibreOffice's `recalc.py`:

```ts
const out = await basis.recalc("model.xlsx", { filename: "model" });
await writeFile(out.filename, out.bytes);
if (!out.summary.ok) {
  for (const e of out.summary.errors) console.log(`${e.sheet}!${e.cell} ${e.error} ${e.formula}`);
  for (const u of out.summary.uncomputed) console.log(`${u.sheet}!${u.cell} not computed: ${u.formula}`);
}
```

The result is `{ filename, contentType, bytes, summary }`. `summary.errors` lists
formula cells that evaluate to `#REF!`, `#DIV/0!`, `#NAME?` and so on (up to
200; exact totals in `error_total` and `error_counts`). `summary.uncomputed`
lists formulas Basis can't evaluate, which are never saved as silent blanks.
`summary.warnings` names content the round trip can't keep (`rich_text_flattened`,
`data_table_dropped`, `array_formula_not_recomputed`). Styles, charts, images,
comments, data validation, defined names and VBA are carried over unchanged.
The call is never retried by the SDK. A file over the upload limit fails with
`payload_too_large`, a non-workbook with `parse_failed`.

`exportSession(sessionId)` returns the same shape for a workbook session held
by the server (created through the hosted MCP endpoint).

## Streaming

`parseStream()`, `jobRecords()` and `jobSheetRecords()` yield records as they
download, so memory stays flat however large the workbook. The request starts
on the first iteration, and breaking out of the loop cancels the download.

```ts
let formulas = 0;
for await (const r of basis.parseStream(file)) {
  if (r.type === "cell" && r.formula !== null) formulas++;
}
```

The server still builds the whole result before it starts sending, so
streaming saves memory on your side, not time to first record.

## Errors

Every failure is a `BasisError`:

| Property | Meaning |
| --- | --- |
| `code` | A `BasisErrorCode` (below). Branch on this, not on `message`. |
| `status` | The HTTP status, when the server answered. |
| `serverCode` | The code exactly as the server sent it. |
| `quota` | On `quota_exceeded`: `{ limit, used, resetAt }` from the `X-Basis-Quota-*` headers. |
| `retryAfter` | Seconds from `Retry-After`, on `rate_limited` (and some 503s). |
| `cause` | The underlying error, for `aborted` and `network_error`. |

Codes from the API:

| Code | Status | When |
| --- | --- | --- |
| `bad_request` | 400 | Malformed request, bad sheet index, or Library save with the operator token. |
| `empty_body` | 400 | The upload was empty. |
| `unauthorized` | 401 | Missing or invalid API key. |
| `quota_exceeded` | 402 | The key's quota for this period is used up. See `quota`. |
| `forbidden` | 403 | The key lacks the scope (operator routes only). |
| `not_found` | 404 | No such job or sheet for this key, or it expired. |
| `session_not_found` | 404 | `saveToLibrary` with an unknown or expired `sessionId`. |
| `method_not_allowed` | 405 | Wrong HTTP method. |
| `job_not_ready` | 409 | The job is still processing. |
| `payload_too_large` | 413 | Over the upload limit (20 MB by default). |
| `decompression_limit_exceeded` | 413 | The workbook expands to more than the server accepts (a zip bomb, or an unusually large file). |
| `rate_limited` | 429 | Too many requests right now. Wait `retryAfter` seconds. |
| `parse_failed` | 422 | The file couldn't be parsed. |
| `worker_timeout` | 422 | The parse ran past the server's time limit. |
| `internal_error` | 500 | Unexpected server error. |
| `library_error` | 502 | The Library rejected or failed the save. |
| `keys_backend_unavailable` | 503 | Operator key routes: key store not configured. |
| `unavailable` | 503 | The deployment has no Library connected. |

Codes from the SDK itself:

| Code | When |
| --- | --- |
| `timeout` | The call's `timeoutMs` ran out. |
| `aborted` | Your `AbortSignal` fired. |
| `network_error` | `fetch` failed (DNS, TLS, connection reset). |
| `invalid_response` | The server answered in a shape the API doesn't document (for example a proxy's HTML error page). |
| `unknown` | The server sent a code this SDK version doesn't know. `serverCode` has it. |

The code lists are exported as `SERVER_ERROR_CODES` and `CLIENT_ERROR_CODES`.

### Retries

The SDK never retries an upload, a job submission or a Library save: those
aren't safe to repeat. With `retry: { maxRetries }` set, it retries GET
requests (job status, results, sheets, health) on `rate_limited`, any 503 and
`network_error`, waiting `Retry-After` when the server gives one and an
exponential backoff otherwise. It won't wait longer than `maxDelayMs`
(default 30 s) for a single retry. For uploads that hit `rate_limited`, wait
`err.retryAfter` seconds yourself and decide whether to send again.

## Timeouts and cancelling

`timeoutMs` bounds the whole call: upload, server work, polling and reading
the result. It defaults to the client's `timeoutMs` (120 s). Pass `Infinity`
to wait as long as it takes. `signal` cancels the call:

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);
await basis.parse(file, { signal: controller.signal, timeoutMs: 600_000 });
// throws BasisError with code "aborted" after 5 s, or "timeout" after 10 min
```

## Browsers and edge runtimes

The package uses only web-standard APIs (`fetch`, `Blob`, `ReadableStream`,
`AbortSignal`, Web Crypto) and loads nothing from Node unless you pass a file
path. In a browser or an edge runtime, pass a `Uint8Array`, `ArrayBuffer`,
`Blob` or `File`.

Two cautions for browsers:

- Your API key would be visible to anyone using the page. Call Basis from
  your own server, or put a proxy in front of it that adds the key.
- The API sends no CORS headers unless Basis has allow-listed your page's
  origin, so by default a browser can only reach it through a same-origin
  proxy. Calling Basis directly from a browser needs your exact origin
  allow-listed on the Basis side, and the key problem above remains. A
  proxy that adds the key on your server is still the recommended setup.

## Webhooks

When a job was submitted with a `webhookUrl`, the server POSTs
`{ job_id, status, records_out, error }` there once it finishes, with
`x-basis-signature: sha256=<hex>`: an HMAC-SHA256 of the raw body under the
webhook secret your Basis operator gives you (not your API key).

```ts
import { verifyWebhookSignature, type WebhookPayload } from "@basis1/parse";

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text(); // the exact bytes; don't re-serialize parsed JSON
  const ok = await verifyWebhookSignature({
    payload: raw,
    signature: req.headers.get("x-basis-signature"),
    secret: process.env.BASIS_WEBHOOK_SECRET!,
  });
  if (!ok) return new Response("bad signature", { status: 401 });
  const event = JSON.parse(raw) as WebhookPayload;
  // The signature has no timestamp, so a delivery can be replayed.
  // Treat it as a prompt and confirm with basis.getJob(event.job_id).
  return new Response(null, { status: 204 });
}
```

Delivery is a single best-effort attempt. Poll `getJob()` if you need
certainty.

## Records

`StreamRecord` is a union discriminated on `type`: `workbook_meta`, `sheet`,
`cell`, `edge`, `image`, `image_summary` and `audit` (itself discriminated on
`finding`: `verification`, `plug`, `plug_summary`, `broken_ref`, `cycles`,
`staleness`). Field-by-field documentation is in the
[API reference](https://api.basis1.tech/docs#records). The types are checked
against the engine's real output before each release.

## Development

```sh
npm ci
npm test               # typecheck + unit, NDJSON and webhook tests
npm run build          # tsc -> dist/
npm run test:pack      # pack, install into a temp project, import from ESM/CJS/TS
BASIS_API_KEY=… npm run test:live   # opt-in smoke test against the real API
```

## License

Apache License 2.0. See [`LICENSE`](LICENSE). The Basis engine and hosted
service are separate and proprietary.
