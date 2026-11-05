// Verifies the `x-basis-signature` header on a job webhook. The server
// (server/webhooks.js) signs the raw JSON body with HMAC-SHA256 under its
// webhook secret and sends `sha256=<lowercase hex>`. There is no timestamp in
// the signed material, so a valid delivery can be replayed; treat the payload
// as a hint and confirm with `getJob()` before acting on it. Uses Web Crypto,
// so it runs on Node 20+, browsers' secure contexts and edge runtimes alike.
import type { JobError, JobLifecycleStatus } from "./types.ts";

/** The JSON body of a job webhook delivery. */
export interface WebhookPayload {
  job_id: string;
  status: Exclude<JobLifecycleStatus, "processing">;
  records_out: number | null;
  error: JobError | null;
}

export interface VerifyWebhookInput {
  /** The request body exactly as received, before any JSON parsing. */
  payload: string | Uint8Array;
  /** The `x-basis-signature` header value (`sha256=<hex>`). */
  signature: string | null | undefined;
  /** The webhook secret your Basis operator gave you. Not your API key. */
  secret: string;
}

const PREFIX = "sha256=";
const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Compares every character so the time taken doesn't reveal how much of a
// forged signature matched.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when `signature` is the server's HMAC-SHA256 of `payload` under `secret`. */
export async function verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean> {
  const { signature, secret } = input;
  if (!secret) throw new TypeError("verifyWebhookSignature needs the webhook secret");
  if (typeof signature !== "string" || !signature.startsWith(PREFIX)) return false;
  const received = signature.slice(PREFIX.length).toLowerCase();
  const body = typeof input.payload === "string" ? encoder.encode(input.payload) : input.payload;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, body as Uint8Array<ArrayBuffer>));
  return constantTimeEqual(received, expected);
}
