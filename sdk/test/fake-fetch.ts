// A scripted stand-in for `fetch`. Each call is recorded and answered by the
// next handler in the queue, so tests assert both what the client sent and
// how it reacts to each response, without a server.

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  signal: AbortSignal | null;
}

export type Handler = (call: RecordedCall) => Response | Promise<Response>;

async function readBody(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null;
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export class FakeFetch {
  public readonly calls: RecordedCall[] = [];
  private readonly queue: Handler[] = [];

  public reply(...handlers: Handler[]): this {
    this.queue.push(...handlers);
    return this;
  }

  public readonly fetch: typeof fetch = async (input, init) => {
    const call: RecordedCall = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: await readBody(init?.body),
      signal: init?.signal ?? null,
    };
    this.calls.push(call);
    const handler = this.queue.shift();
    if (!handler) throw new Error(`unexpected request ${call.method} ${call.url.pathname}`);
    return handler(call);
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Handler {
  return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function ndjson(text: string, headers: Record<string, string> = {}): Handler {
  return () => new Response(text, { status: 200, headers: { "content-type": "application/x-ndjson", ...headers } });
}

export function errorEnvelope(status: number, code: string, message: string, headers: Record<string, string> = {}): Handler {
  return json(status, { error: { code, message } }, headers);
}

/** A response whose body arrives in the given chunks, one per read. */
export function chunked(chunks: Uint8Array[]): Handler {
  return () => {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[i++];
        if (next === undefined) controller.close();
        else controller.enqueue(next);
      },
    });
    return new Response(stream, { status: 200 });
  };
}

/** Never answers until the request's signal aborts, then rejects like fetch does. */
export function hang(): Handler {
  return (call) =>
    new Promise<Response>((_, reject) => {
      const signal = call.signal;
      if (!signal) return;
      const fail = (): void => reject(new DOMException("This operation was aborted", "AbortError"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
}

export const JOB_ID = "6f1c2b9e-1d2a-4c3b-9e8f-0a1b2c3d4e5f";

export function jobHandle(id: string = JOB_ID): Handler {
  return json(202, { job_id: id, status: "processing", status_url: `/v1/jobs/${id}`, stream_url: `/v1/jobs/${id}/stream` });
}

export function jobStatus(status: "processing" | "completed" | "failed", error: { code: string; message: string } | null = null): Handler {
  return json(200, {
    job_id: JOB_ID,
    status,
    created_at: "2026-11-03T00:00:00.000Z",
    updated_at: "2026-11-03T00:00:01.000Z",
    expires_at: "2026-11-04T00:00:00.000Z",
    bytes_in: 4,
    records_out: status === "completed" ? 2 : null,
    stream_url: `/v1/jobs/${JOB_ID}/stream`,
    sheets_url: status === "completed" ? `/v1/jobs/${JOB_ID}/sheets` : null,
    error,
  });
}

export const META = '{"type":"workbook_meta","date_system":"1900","calc_iterative":false,"calc_count":null,"has_vba":false,"sheet_count":1,"core_properties":{},"defined_names":[]}';
export const CELL = '{"type":"cell","sheet":0,"ref":"A1","kind":"number","num":1,"str":null,"formula":null,"fmt":null,"err":null}';
export const TWO_RECORDS = `${META}\n${CELL}\n`;
