// The parse tools: thin wrappers over @basis1/parse, which owns sync-vs-job
// routing, polling and NDJSON framing. These always call the Basis API,
// whichever engine runs the workbook tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Basis } from "@basis1/parse";
import { apiToolAnnotations } from "./engine/catalog.ts";
import { countInputs, resolveBytes } from "./input.ts";
import { errorResult, jsonResult, textResult } from "./results.ts";

export interface ApiToolDeps {
  /** Returns the API client, or throws when no API key is configured. */
  basis: () => Basis;
  maxFetchBytes: number;
}

export const API_TOOL_NAMES = ["parse_workbook", "submit_job", "get_job_status", "stream_job", "diff_workbooks"] as const;

const workbookInputShape = {
  path: z.string().optional().describe("Local filesystem path to an .xlsx file (read on this machine, then uploaded)"),
  url: z.string().url().optional().describe("URL to fetch the .xlsx file from"),
  base64: z.string().optional().describe("Base64-encoded .xlsx file bytes"),
  webhook_url: z.string().url().optional().describe("https URL that gets an HMAC-signed POST with the job's status when the parse finishes"),
};

const diffInputShape = {
  before_path: z.string().optional().describe("Local filesystem path to the first (before) .xlsx file"),
  before_url: z.string().url().optional().describe("URL to fetch the first (before) .xlsx file from"),
  before_base64: z.string().optional().describe("Base64-encoded bytes of the first (before) .xlsx file"),
  after_path: z.string().optional().describe("Local filesystem path to the second (after) .xlsx file"),
  after_url: z.string().url().optional().describe("URL to fetch the second (after) .xlsx file from"),
  after_base64: z.string().optional().describe("Base64-encoded bytes of the second (after) .xlsx file"),
  include_format: z.boolean().optional().describe("Report cells whose only change is number format (default true)"),
};

export function registerApiTools(server: McpServer, deps: ApiToolDeps): void {
  const bytesOf = (input: { path?: string; url?: string; base64?: string }) => resolveBytes(input, deps.maxFetchBytes);

  server.registerTool(
    "parse_workbook",
    {
      title: "Parse workbook",
      annotations: apiToolAnnotations.parse_workbook,
      description:
        "Parse an .xlsx workbook in one call and return its full semantic NDJSON: one JSON record per line " +
        "(workbook_meta, sheet, cell, edge, image, image_summary, audit), covering every cell's value and formula and " +
        "the formula dependency edges. Use it to read a whole file without opening a session; large files are handed " +
        "to an async job and awaited for you. To start a parse without waiting, use submit_job; to read a few cells " +
        "or edit, use create_session; to compare two files, use diff_workbooks. Pass exactly one of path, url or " +
        "base64 (up to 20 MB). The file is uploaded to the Basis API, and each call counts against the API key's " +
        "parse quota (quota_exceeded once it is used up). webhook_url, if set, also gets an HMAC-signed POST when the " +
        "parse finishes.",
      inputSchema: workbookInputShape,
    },
    async (args) => {
      if (countInputs(args) !== 1) return errorResult(new Error("exactly one of path, url, or base64 is required"));
      try {
        const ndjson = await deps.basis().parseRaw(await bytesOf(args), { webhookUrl: args.webhook_url });
        return textResult(ndjson);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "submit_job",
    {
      title: "Submit parse job",
      annotations: apiToolAnnotations.submit_job,
      description:
        "Start an async parse of an .xlsx workbook and return at once with a job handle {job_id, status: " +
        "\"processing\", status_url, stream_url}. Use it instead of parse_workbook for large files or when you don't " +
        "want to wait: poll get_job_status until status is \"completed\", then read the records with stream_job. Every " +
        "call starts a new job and counts against the API key's parse quota, so don't resubmit a file whose job is " +
        "still running. Pass exactly one of path, url or base64 (up to 20 MB); the file is uploaded to the Basis API. " +
        "webhook_url, if set, gets an HMAC-signed POST when the job finishes, so you can skip polling.",
      inputSchema: workbookInputShape,
    },
    async (args) => {
      if (countInputs(args) !== 1) return errorResult(new Error("exactly one of path, url, or base64 is required"));
      try {
        const job = await deps.basis().submitJob(await bytesOf(args), { webhookUrl: args.webhook_url });
        return jsonResult(job);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_job_status",
    {
      title: "Get job status",
      annotations: apiToolAnnotations.get_job_status,
      description:
        "Check on a parse job started by submit_job. Returns {job_id, status, created_at, updated_at, expires_at, " +
        "bytes_in, records_out, stream_url, error}, where status is \"processing\", \"completed\" or \"failed\". It is a " +
        "cheap read, so poll it every few seconds until status changes; then read the records with stream_job, or the " +
        "error when the job failed. Results are kept until expires_at. An unknown or expired job_id, or one submitted " +
        "with another API key, fails with not_found. parse_workbook returns its result directly and needs no status " +
        "check.",
      inputSchema: { job_id: z.string().describe("Job ID returned by submit_job") },
    },
    async ({ job_id }) => {
      try {
        return jsonResult(await deps.basis().getJob(job_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "stream_job",
    {
      title: "Stream job output",
      annotations: apiToolAnnotations.stream_job,
      description:
        "Return the NDJSON records of a finished parse job from submit_job: the same output parse_workbook returns, " +
        "one JSON record per line. Call it once get_job_status reports \"completed\": a job still processing fails with " +
        "job_not_ready (poll again), a failed job returns its parse error, and an unknown or expired job_id fails " +
        "with not_found. Everything after `since` comes back in one result, with no paging; pass since to skip " +
        "records you already have.",
      inputSchema: {
        job_id: z.string().describe("Job ID returned by submit_job"),
        since: z.number().int().nonnegative().optional().describe("Number of records to skip from the start (the 0-based index of the first record to return; default 0)"),
      },
    },
    async ({ job_id, since }) => {
      try {
        return textResult(await deps.basis().streamJob(job_id, since));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "diff_workbooks",
    {
      title: "Diff workbooks",
      annotations: apiToolAnnotations.diff_workbooks,
      description:
        "Compare two .xlsx files cell by cell and return the differences as JSON: {summary, added, removed, changed, " +
        "format_changed}. Cells are matched on (sheet title, cell ref); changed covers value and formula changes, and " +
        "format-only changes are listed separately. Use it to see what changed between two versions of a file, such " +
        "as before and after an edit. For problems inside one workbook use audit_workbook; to undo edits in a session " +
        "use restore_session. Provide exactly one of before_path/before_url/before_base64 and one of " +
        "after_path/after_url/after_base64. Both files are uploaded to and parsed on the Basis API (up to 20 MB each) " +
        "and count against the API key's parse quota; nothing is stored.",
      inputSchema: diffInputShape,
    },
    async (args) => {
      const before = { path: args.before_path, url: args.before_url, base64: args.before_base64 };
      const after = { path: args.after_path, url: args.after_url, base64: args.after_base64 };
      if (countInputs(before) !== 1) {
        return errorResult(new Error("exactly one of before_path, before_url, or before_base64 is required"));
      }
      if (countInputs(after) !== 1) {
        return errorResult(new Error("exactly one of after_path, after_url, or after_base64 is required"));
      }
      try {
        const [beforeBytes, afterBytes] = await Promise.all([bytesOf(before), bytesOf(after)]);
        const diff = await deps.basis().diffWorkbooks(beforeBytes, afterBytes, { includeFormat: args.include_format });
        return jsonResult(diff);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
