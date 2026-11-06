// The parse tools against a stub API client: stream_job's status_only and
// wait_seconds, which replace the retired get_job_status tool.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Basis } from "@basis1/parse";
import { API_TOOL_NAMES, registerApiTools } from "../src/api-tools.ts";

interface Stub {
  statuses: string[];
  getJobCalls: number;
  streamCalls: Array<number | undefined>;
}

/** A client whose job reports each of `statuses` in turn (then the last one). */
function stubBasis(statuses: string[]): { basis: Basis; stub: Stub } {
  const stub: Stub = { statuses, getJobCalls: 0, streamCalls: [] };
  const basis = {
    async getJob(jobId: string) {
      const status = statuses[Math.min(stub.getJobCalls, statuses.length - 1)];
      stub.getJobCalls++;
      return { job_id: jobId, status };
    },
    async streamJob(_jobId: string, since?: number) {
      stub.streamCalls.push(since);
      return '{"type":"workbook_meta"}\n';
    },
  } as unknown as Basis;
  return { basis, stub };
}

async function connect(basis: Basis): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0" });
  registerApiTools(server, { basis: () => basis, maxFetchBytes: 1024 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(b);
  return client;
}

function text(r: CallToolResult): string {
  const c = r.content[0];
  assert.ok(c && c.type === "text");
  return c.text;
}

describe("stream_job", () => {
  test("the parse tools no longer include get_job_status", async () => {
    const client = await connect(stubBasis(["completed"]).basis);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.deepEqual(names.sort(), [...API_TOOL_NAMES].sort());
    assert.ok(!names.includes("get_job_status"));
    await client.close();
  });

  test("status_only returns the job's status without reading records", async () => {
    const { basis, stub } = stubBasis(["processing"]);
    const client = await connect(basis);
    const r = (await client.callTool({ name: "stream_job", arguments: { job_id: "j1", status_only: true } })) as CallToolResult;
    assert.deepEqual(JSON.parse(text(r)), { job_id: "j1", status: "processing" });
    assert.deepEqual(stub.streamCalls, []);
    await client.close();
  });

  test("wait_seconds polls until the job finishes, then returns its records", async () => {
    const { basis, stub } = stubBasis(["processing", "completed"]);
    const client = await connect(basis);
    const r = (await client.callTool({ name: "stream_job", arguments: { job_id: "j1", wait_seconds: 5, since: 2 } })) as CallToolResult;
    assert.equal(text(r), '{"type":"workbook_meta"}\n');
    assert.equal(stub.getJobCalls, 2);
    assert.deepEqual(stub.streamCalls, [2]);
    await client.close();
  });

  test("without wait_seconds it reads straight away", async () => {
    const { basis, stub } = stubBasis(["completed"]);
    const client = await connect(basis);
    await client.callTool({ name: "stream_job", arguments: { job_id: "j1" } });
    assert.equal(stub.getJobCalls, 0);
    assert.deepEqual(stub.streamCalls, [undefined]);
    await client.close();
  });

  test("wait_seconds over 60 is refused", async () => {
    const client = await connect(stubBasis(["completed"]).basis);
    const r = (await client.callTool({ name: "stream_job", arguments: { job_id: "j1", wait_seconds: 61 } })) as CallToolResult;
    assert.equal(r.isError, true);
    await client.close();
  });
});
