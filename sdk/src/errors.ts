// Every failure the client surfaces is a BasisError with a typed `.code`, so
// callers branch on the kind of failure instead of parsing messages. Server
// codes come from the `{ error: { code, message } }` envelope written by
// `errRes()` in server/index.js; the SDK adds a few of its own for failures
// that never reach the server (timeouts, aborts, network errors).

/** Codes the Basis API returns in its error envelope. */
export const SERVER_ERROR_CODES = [
  "bad_request",
  "empty_body",
  "unauthorized",
  "quota_exceeded",
  "forbidden",
  "not_found",
  "session_not_found",
  "method_not_allowed",
  "job_not_ready",
  "payload_too_large",
  "result_too_large",
  "decompression_limit_exceeded",
  "rate_limited",
  "parse_failed",
  "worker_timeout",
  "internal_error",
  "library_error",
  "keys_backend_unavailable",
  "unavailable",
] as const;

/** Codes the SDK assigns itself when the server never answered usefully. */
export const CLIENT_ERROR_CODES = [
  /** The call's `timeoutMs` elapsed (request, upload, polling or reading). */
  "timeout",
  /** The caller's `AbortSignal` fired. `cause` holds the signal's reason. */
  "aborted",
  /** `fetch` itself failed: DNS, TLS, connection reset. `cause` holds the error. */
  "network_error",
  /** The server answered, but not in the shape the API documents. */
  "invalid_response",
  /** The server sent an error code this SDK version doesn't know; see `serverCode`. */
  "unknown",
] as const;

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number];
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type BasisErrorCode = ServerErrorCode | ClientErrorCode;

/** Present on 402 `quota_exceeded`, from the `X-Basis-Quota-*` headers. */
export interface QuotaDetail {
  /** Which quota ran out. Absent on servers that predate the dimension header. */
  dimension?: "requests" | "bytes_in" | "cells_out";
  /** The key's limit for the exhausted dimension in the current period. */
  limit: number;
  /** How much of that limit is already used. */
  used: number;
  /** When the period resets, as the ISO 8601 string the server sent. */
  resetAt: string;
}

export interface BasisErrorInit {
  status?: number;
  serverCode?: string;
  quota?: QuotaDetail;
  retryAfter?: number;
  cause?: unknown;
}

const KNOWN_SERVER_CODES: ReadonlySet<string> = new Set(SERVER_ERROR_CODES);

export function isServerErrorCode(code: string): code is ServerErrorCode {
  return KNOWN_SERVER_CODES.has(code);
}

export class BasisError extends Error {
  /** What went wrong, as a stable machine-readable code. */
  public readonly code: BasisErrorCode;
  /** HTTP status, when the failure came from a server response. */
  public readonly status?: number;
  /** The code exactly as the server sent it, even when this SDK doesn't know it. */
  public readonly serverCode?: string;
  /** Quota detail on 402 `quota_exceeded`. */
  public readonly quota?: QuotaDetail;
  /** Seconds the server asked us to wait (`Retry-After`), on 429 and some 503s. */
  public readonly retryAfter?: number;

  public constructor(message: string, code: BasisErrorCode, init: BasisErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "BasisError";
    this.code = code;
    this.status = init.status;
    this.serverCode = init.serverCode;
    this.quota = init.quota;
    this.retryAfter = init.retryAfter;
  }
}

function readQuota(headers: Headers): QuotaDetail | undefined {
  const limit = Number(headers.get("x-basis-quota-limit"));
  const used = Number(headers.get("x-basis-quota-used"));
  const resetAt = headers.get("x-basis-quota-reset");
  if (!headers.has("x-basis-quota-limit") || !Number.isFinite(limit)) return undefined;
  if (!Number.isFinite(used) || !resetAt) return undefined;
  const dim = headers.get("x-basis-quota-dimension");
  const dimension = dim === "requests" || dim === "bytes_in" || dim === "cells_out" ? dim : undefined;
  return { limit, used, resetAt, ...(dimension ? { dimension } : {}) };
}

/** Parses `Retry-After` as delta-seconds or an HTTP date; returns whole seconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function readEnvelope(body: unknown): { code?: string; message?: string } {
  if (typeof body !== "object" || body === null) return {};
  const err = (body as { error?: unknown }).error;
  if (typeof err !== "object" || err === null) return {};
  const { code, message } = err as { code?: unknown; message?: unknown };
  return {
    code: typeof code === "string" ? code : undefined,
    message: typeof message === "string" ? message : undefined,
  };
}

/** Maps a non-2xx response to a BasisError, reading the JSON envelope if any. */
export async function toBasisError(res: Response): Promise<BasisError> {
  let envelope: { code?: string; message?: string } = {};
  try {
    envelope = readEnvelope(await res.json());
  } catch {
    // Not JSON (a proxy's HTML page, say): keep the status-only message.
  }
  const serverCode = envelope.code;
  const code: BasisErrorCode = serverCode === undefined
    ? "invalid_response"
    : isServerErrorCode(serverCode) ? serverCode : "unknown";
  return new BasisError(envelope.message ?? `Basis API returned HTTP ${res.status}`, code, {
    status: res.status,
    serverCode,
    quota: res.status === 402 ? readQuota(res.headers) : undefined,
    retryAfter: parseRetryAfter(res.headers.get("retry-after")),
  });
}

/** Error for a job that finished with `status: "failed"`. */
export function jobFailedError(jobId: string, error: { code?: string; message?: string } | null): BasisError {
  const serverCode = error?.code ?? "parse_failed";
  const code: BasisErrorCode = isServerErrorCode(serverCode) ? serverCode : "unknown";
  // Same status the server's job routes answer with for this code.
  const status = serverCode === "decompression_limit_exceeded" ? 413 : 422;
  return new BasisError(error?.message ?? `job ${jobId} failed`, code, { status, serverCode });
}
