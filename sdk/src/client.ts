// The Basis API client. `parse()` hides sync-inline (200) vs job-shaped
// (202 + poll) entirely: same signature and return type either way, so callers
// never need to know which path the server took for a given file.
//
// Every public call runs inside one Deadline (timeout + caller AbortSignal)
// that covers all of its HTTP requests. Only GETs are ever retried, and only
// when the caller opts in; uploads, job submissions and Library saves are
// sent exactly once.
import { Deadline, type CallOptions } from "./deadline.ts";
import { diffRecords, type DiffOptions, type WorkbookDiff } from "./diff.ts";
import { BasisError, jobFailedError, toBasisError } from "./errors.ts";
import { contentTypeFor, toBody, type FileInput } from "./input.ts";
import { readNdjson } from "./ndjson.ts";
import type { ExportedWorkbook, ExportSummary, Job, JobStatus, LibrarySaveResult, SheetInfo, StreamRecord } from "./types.ts";

export type { CallOptions } from "./deadline.ts";
export type { FileInput } from "./input.ts";

/** Opt-in retries for idempotent GET requests. Never applied to uploads. */
export interface RetryOptions {
  /** Retries after the first attempt. 0 disables retrying. */
  maxRetries: number;
  /** Longest single wait. A `Retry-After` above this is not waited out. Default 30 s. */
  maxDelayMs?: number;
}

export interface BasisOptions {
  /** Your API key (`basis_live_…`), sent as `Authorization: Bearer`. */
  token: string;
  /** Base URL of the Basis API. Defaults to `https://api.basis1.tech`. */
  baseUrl?: string;
  /** How often to poll a job's status while `parse()` waits for it. Default 500 ms. */
  pollIntervalMs?: number;
  /** Default upper bound for each call, in milliseconds. Default 120 000. `Infinity` disables it. */
  timeoutMs?: number;
  /** Retry GETs on 429, 503 and network errors. Off by default. */
  retry?: RetryOptions;
  /** A `fetch` implementation to use instead of the global one. */
  fetch?: typeof fetch;
}

/**
 * `"auto"` (default) lets the server answer inline for small files and hand
 * back a job for large ones. `"sync"` forces an inline answer however long
 * the parse takes. `"job"` forces the job path.
 */
export type ParseMode = "auto" | "sync" | "job";

export interface ParseOptions extends CallOptions {
  /** Receives an HMAC-SHA256-signed POST when the job completes or fails. */
  webhookUrl?: string;
  mode?: ParseMode;
}

export interface SubmitJobOptions extends CallOptions {
  webhookUrl?: string;
}

export interface RecordStreamOptions extends CallOptions {
  /** Skip the first `since` records (a record index, for resuming). */
  since?: number;
}

export interface SaveToLibraryOptions extends CallOptions {
  /** Name for a new Library file. Ignored when `fileId` is given. */
  name?: string;
  /** Save as a new version of this Library file instead of creating one. */
  fileId?: string;
  /** A workbook session held by the Basis server to save instead of `input`. */
  sessionId?: string;
  /** The version's name in the Library's history. */
  message?: string;
}

export type DiffWorkbooksOptions = DiffOptions & CallOptions;

export interface RecalcOptions extends CallOptions {
  /** Name for the returned file (default `workbook.xlsx`). */
  filename?: string;
}

/** The JSON body of `?format=json` on the recalc and export routes. */
interface ExportWire {
  filename: string;
  content_type: string;
  file_base64: string;
  summary: ExportSummary;
}

function decodeExport(wire: ExportWire): ExportedWorkbook {
  const binary = atob(wire.file_base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { filename: wire.filename, contentType: wire.content_type, bytes, summary: wire.summary };
}

const DEFAULT_BASE_URL = "https://api.basis1.tech";
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const RETRY_BASE_DELAY_MS = 500;
const OCTET_STREAM = "application/octet-stream";

interface SendInit {
  method: "GET" | "POST" | "QUERY";
  body?: BodyInit;
}

// Drops trailing slashes. A loop, not /\/+$/: that regex backtracks
// quadratically on long runs of slashes (CodeQL js/polynomial-redos).
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${value}`);
  }
}

function withQuery(path: string, params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

function sinceQuery(since: number | undefined): URLSearchParams {
  const params = new URLSearchParams();
  if (since === undefined) return params;
  requireNonNegativeInteger("since", since);
  params.set("since", String(since));
  return params;
}

function jobPath(jobId: string): string {
  if (typeof jobId !== "string" || jobId.length === 0) throw new TypeError("jobId must be a non-empty string");
  return `/v1/jobs/${encodeURIComponent(jobId)}`;
}

function sheetPath(jobId: string, index: number): string {
  requireNonNegativeInteger("sheet index", index);
  return `${jobPath(jobId)}/sheets/${index}`;
}

/** Reads a JSON body; a broken connection is `network_error`, bad JSON `invalid_response`. */
async function readJson<T>(res: Response, d: Deadline): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw d.translate(err);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new BasisError("the Basis API returned a body that isn't JSON", "invalid_response", { status: res.status, cause: err });
  }
}

function bodyStream(res: Response): ReadableStream<Uint8Array> {
  if (res.body === null) return new ReadableStream({ start: (c) => c.close() });
  return res.body;
}

export class Basis {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly retry: Required<RetryOptions>;
  private readonly fetchImpl: typeof fetch;

  public constructor(opts: BasisOptions) {
    if (typeof opts?.token !== "string" || opts.token.length === 0) {
      throw new TypeError("Basis needs an API key: new Basis({ token: process.env.BASIS_API_KEY })");
    }
    this.token = opts.token;
    this.baseUrl = trimTrailingSlashes(opts.baseUrl ?? DEFAULT_BASE_URL);
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = {
      maxRetries: opts.retry?.maxRetries ?? 0,
      maxDelayMs: opts.retry?.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
    };
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") throw new TypeError("no fetch available; pass one as `fetch`");
    // Called unbound, as browsers require for the global fetch.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    // Fail fast on a bad default rather than on the first call.
    new Deadline(this.timeoutMs).dispose();
  }

  /** Parse a workbook and return all its records. Sync-vs-async is invisible. */
  public async parse(input: FileInput, opts: ParseOptions = {}): Promise<StreamRecord[]> {
    const out: StreamRecord[] = [];
    for await (const rec of this.parseStream(input, opts)) out.push(rec);
    return out;
  }

  /**
   * Parse a workbook and yield records as they arrive, without holding the
   * whole result in memory. The request starts on the first iteration;
   * breaking out of the loop cancels the download.
   */
  public async *parseStream(input: FileInput, opts: ParseOptions = {}): AsyncGenerator<StreamRecord, void, undefined> {
    yield* this.records(opts, (d) => this.openParseResult(input, opts, d));
  }

  /** Same routing as `parse()`, but returns the raw NDJSON text. */
  public async parseRaw(input: FileInput, opts: ParseOptions = {}): Promise<string> {
    return this.text(opts, (d) => this.openParseResult(input, opts, d));
  }

  /**
   * Diff two workbooks cell by cell. Both are parsed in parallel and joined on
   * (sheet title, cell ref). To diff records you already have, call the
   * exported `diffRecords()` instead.
   */
  public async diffWorkbooks(before: FileInput, after: FileInput, opts: DiffWorkbooksOptions = {}): Promise<WorkbookDiff> {
    const { signal, timeoutMs, ...diffOpts } = opts;
    const [beforeRecords, afterRecords] = await Promise.all([
      this.parse(before, { signal, timeoutMs }),
      this.parse(after, { signal, timeoutMs }),
    ]);
    return diffRecords(beforeRecords, afterRecords, diffOpts);
  }

  /**
   * Single-shot `QUERY /api/v1/stream`: no job bookkeeping, always blocks,
   * capped at the stream endpoint's size limit. Returns NDJSON text.
   */
  public async queryStream(input: FileInput, opts: CallOptions = {}): Promise<string> {
    return this.text(opts, async (d) => this.send("/api/v1/stream", { method: "QUERY", body: await this.body(input) }, d));
  }

  /** Always returns a job handle (202), even for files that could parse inline. */
  public async submitJob(input: FileInput, opts: SubmitJobOptions = {}): Promise<Job> {
    return this.json<Job>(opts, async (d) => {
      const res = await this.postJob(input, { webhookUrl: opts.webhookUrl, mode: "job" }, d);
      if (res.status !== 202) {
        await res.body?.cancel().catch(() => undefined);
        throw new BasisError(`expected 202 from POST /v1/jobs?mode=job, got ${res.status}`, "invalid_response", { status: res.status });
      }
      return res;
    });
  }

  public async getJob(jobId: string, opts: CallOptions = {}): Promise<JobStatus> {
    return this.json<JobStatus>(opts, (d) => this.send(jobPath(jobId), { method: "GET" }, d));
  }

  /** A finished job's NDJSON. Pass `since` (a record index) to fetch only the tail. */
  public async streamJob(jobId: string, since?: number, opts: CallOptions = {}): Promise<string> {
    return this.text(opts, (d) => this.send(withQuery(`${jobPath(jobId)}/stream`, sinceQuery(since)), { method: "GET" }, d));
  }

  /** A finished job's records, yielded as they arrive. */
  public async *jobRecords(jobId: string, opts: RecordStreamOptions = {}): AsyncGenerator<StreamRecord, void, undefined> {
    yield* this.records(opts, (d) => this.send(withQuery(`${jobPath(jobId)}/stream`, sinceQuery(opts.since)), { method: "GET" }, d));
  }

  /** A finished job's sheets, each with its own resumable stream URL. */
  public async listJobSheets(jobId: string, opts: CallOptions = {}): Promise<SheetInfo[]> {
    return this.json<SheetInfo[]>(opts, (d) => this.send(`${jobPath(jobId)}/sheets`, { method: "GET" }, d));
  }

  /**
   * One sheet's NDJSON (`sheet`/`cell`/`image` records only). `since` is a
   * record index within this sheet's own sub-stream.
   */
  public async streamJobSheet(jobId: string, index: number, since?: number, opts: CallOptions = {}): Promise<string> {
    return this.text(opts, (d) => this.send(withQuery(`${sheetPath(jobId, index)}/stream`, sinceQuery(since)), { method: "GET" }, d));
  }

  /** One sheet's records, yielded as they arrive. */
  public async *jobSheetRecords(jobId: string, index: number, opts: RecordStreamOptions = {}): AsyncGenerator<StreamRecord, void, undefined> {
    yield* this.records(opts, (d) => this.send(withQuery(`${sheetPath(jobId, index)}/stream`, sinceQuery(opts.since)), { method: "GET" }, d));
  }

  /**
   * Save a workbook to the key owner's Library: a new file, or a new version
   * of `fileId`. Needs a per-user API key. Sent once, never retried.
   */
  public async saveToLibrary(input: FileInput, opts: SaveToLibraryOptions = {}): Promise<LibrarySaveResult> {
    const params = new URLSearchParams();
    if (opts.name) params.set("name", opts.name);
    if (opts.fileId) params.set("file_id", opts.fileId);
    if (opts.sessionId) params.set("session_id", opts.sessionId);
    if (opts.message) params.set("message", opts.message);
    return this.json<LibrarySaveResult>(opts, async (d) =>
      this.send(withQuery("/v1/library/save", params), { method: "POST", body: await this.body(input) }, d),
    );
  }

  /**
   * Recalculate a workbook and get it back with every formula's computed value
   * saved in the file. Use it after writing a workbook with openpyxl or another
   * library that saves formulas without results: readers that are not Excel
   * (pandas, openpyxl `data_only`) see empty cells until this is done. The
   * summary lists formula errors with their cells. Sent once, never retried.
   */
  public async recalc(input: FileInput, opts: RecalcOptions = {}): Promise<ExportedWorkbook> {
    const params = new URLSearchParams({ format: "json" });
    if (opts.filename) params.set("filename", opts.filename);
    const wire = await this.json<ExportWire>(opts, async (d) =>
      this.send(withQuery("/v1/recalc", params), { method: "POST", body: await this.body(input) }, d),
    );
    return decodeExport(wire);
  }

  /**
   * A workbook session's current workbook as an .xlsx with computed values
   * (the `export_workbook` MCP tool). Sessions are created through the hosted
   * MCP endpoint; `sessionId` is its `session_id`.
   */
  public async exportSession(sessionId: string, opts: CallOptions = {}): Promise<ExportedWorkbook> {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new TypeError("sessionId must be a non-empty string");
    const wire = await this.json<ExportWire>(opts, (d) =>
      this.send(`/v1/sessions/${encodeURIComponent(sessionId)}/export?format=json`, { method: "GET" }, d),
    );
    return decodeExport(wire);
  }

  /** Resolves `true` when the API is up; throws `BasisError` otherwise. */
  public async healthz(opts: CallOptions = {}): Promise<true> {
    await this.text(opts, (d) => this.send("/healthz", { method: "GET" }, d));
    return true;
  }

  // ---- internals ------------------------------------------------------------

  private deadline(opts: CallOptions): Deadline {
    return new Deadline(opts.timeoutMs ?? this.timeoutMs, opts.signal);
  }

  private async body(input: FileInput): Promise<BodyInit> {
    return (await toBody(input)) as BodyInit;
  }

  private async json<T>(opts: CallOptions, open: (d: Deadline) => Promise<Response>): Promise<T> {
    const d = this.deadline(opts);
    try {
      const res = await open(d);
      return await readJson<T>(res, d);
    } catch (err) {
      throw d.settle(err);
    } finally {
      d.dispose();
    }
  }

  private async text(opts: CallOptions, open: (d: Deadline) => Promise<Response>): Promise<string> {
    const d = this.deadline(opts);
    try {
      const res = await open(d);
      return await res.text().catch((err: unknown) => {
        throw d.translate(err);
      });
    } catch (err) {
      throw d.settle(err);
    } finally {
      d.dispose();
    }
  }

  private async *records(opts: CallOptions, open: (d: Deadline) => Promise<Response>): AsyncGenerator<StreamRecord, void, undefined> {
    const d = this.deadline(opts);
    try {
      const res = await open(d);
      try {
        yield* readNdjson(bodyStream(res));
      } catch (err) {
        throw d.translate(err);
      }
    } catch (err) {
      throw d.settle(err);
    } finally {
      d.dispose();
    }
  }

  /** POST /v1/jobs, then (on 202) poll and open the finished stream. */
  private async openParseResult(input: FileInput, opts: ParseOptions, d: Deadline): Promise<Response> {
    const mode = opts.mode === "auto" ? undefined : opts.mode;
    const res = await this.postJob(input, { webhookUrl: opts.webhookUrl, mode }, d);
    if (res.status === 200) return res;
    if (res.status !== 202) {
      await res.body?.cancel().catch(() => undefined);
      throw new BasisError(`unexpected HTTP ${res.status} from POST /v1/jobs`, "invalid_response", { status: res.status });
    }
    const job = await readJson<Job>(res, d);
    await this.waitForJob(job.job_id, d);
    return this.send(`${jobPath(job.job_id)}/stream`, { method: "GET" }, d);
  }

  private async waitForJob(jobId: string, d: Deadline): Promise<void> {
    for (;;) {
      const res = await this.send(jobPath(jobId), { method: "GET" }, d);
      const status = await readJson<JobStatus>(res, d);
      if (status.status === "completed") return;
      if (status.status === "failed") throw jobFailedError(jobId, status.error);
      await d.sleep(this.pollIntervalMs);
    }
  }

  private async postJob(
    input: FileInput,
    opts: { webhookUrl?: string; mode?: "sync" | "job" },
    d: Deadline,
  ): Promise<Response> {
    const params = new URLSearchParams();
    if (opts.mode) params.set("mode", opts.mode);
    if (opts.webhookUrl) params.set("webhook_url", opts.webhookUrl);
    return this.send(withQuery("/v1/jobs", params), { method: "POST", body: await this.body(input) }, d);
  }

  /** One HTTP exchange. Throws BasisError for non-2xx; retries only GETs, only if enabled. */
  private async send(path: string, init: SendInit, d: Deadline): Promise<Response> {
    const retryable = init.method === "GET";
    for (let attempt = 0; ; attempt++) {
      d.throwIfStopped();
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: init.method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(init.body === undefined ? {} : { "content-type": contentTypeFor(init.body, OCTET_STREAM) }),
          },
          body: init.body,
          signal: d.signal,
        });
      } catch (err) {
        const error = d.translate(err);
        const wait = retryable ? this.retryDelay(error, attempt) : undefined;
        if (wait === undefined) throw error;
        await d.sleep(wait);
        continue;
      }
      if (res.ok) return res;
      const error = await toBasisError(res);
      const wait = retryable ? this.retryDelay(error, attempt) : undefined;
      if (wait === undefined) throw error;
      await d.sleep(wait);
    }
  }

  /** Milliseconds to wait before retrying, or undefined to give up. */
  private retryDelay(error: BasisError, attempt: number): number | undefined {
    if (attempt >= this.retry.maxRetries) return undefined;
    const transient = error.code === "rate_limited" || error.code === "network_error" || error.status === 503;
    if (!transient) return undefined;
    if (error.retryAfter !== undefined) {
      const ms = error.retryAfter * 1000;
      return ms <= this.retry.maxDelayMs ? ms : undefined;
    }
    const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt;
    return Math.min(this.retry.maxDelayMs, backoff / 2 + Math.random() * (backoff / 2));
  }
}
