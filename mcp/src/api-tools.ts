// The parse tools: thin wrappers over @basis1/parse, which owns sync-vs-job
// routing, polling and NDJSON framing. These always call the Basis API,
// whichever engine runs the workbook tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Basis } from "@basis1/parse";
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
  webhook_url: z.string().url().optional().describe("HMAC-signed POST here when the parse completes"),
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
      description:
        "Parse an .xlsx workbook on the Basis API and return the full semantic NDJSON output (workbook_meta, sheet, cell, edge, image, image_summary, audit records). Handles small vs. large files transparently. The file is uploaded to the Basis API.",
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
      description:
        "Submit an .xlsx workbook to the Basis API for async parsing and get back a job handle (job_id, status_url, stream_url) without waiting for it to finish.",
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
      description: "Check the status of a parse job submitted via submit_job.",
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
      description: "Fetch the NDJSON output of a completed parse job. Pass `since` to resume from a record index.",
      inputSchema: {
        job_id: z.string().describe("Job ID returned by submit_job"),
        since: z.number().int().nonnegative().optional().describe("Record index to resume from"),
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
      description:
        "Compare two .xlsx workbooks and return the cell-level differences as JSON. Both files are parsed on the Basis API, joined on (sheet title, cell ref) and classified into added, removed, and changed (value and/or formula), with format-only changes bucketed separately. Provide exactly one of before_path/before_url/before_base64 and one of after_path/after_url/after_base64.",
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
