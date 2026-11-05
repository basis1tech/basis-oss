import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHostedEngine, withUploadedPath } from "../src/engine/hosted.ts";
import { GOOD_KEY, startFakeHosted, type FakeHosted } from "./fake-hosted.ts";

function text(r: CallToolResult): string {
  const c = r.content[0];
  assert.ok(c && c.type === "text");
  return c.text;
}

function errorPayload(r: CallToolResult): { code: string; message: string } {
  assert.equal(r.isError, true, `expected an error, got ${text(r)}`);
  return JSON.parse(text(r));
}

describe("hosted engine", () => {
  let fake: FakeHosted;
  let dir: string;
  before(async () => {
    fake = await startFakeHosted();
    dir = mkdtempSync(join(tmpdir(), "basis-mcp-hosted-"));
  });
  after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("forwards a call with the arguments unchanged and the key as a bearer token", async () => {
    const engine = createHostedEngine({ mcpUrl: `${fake.url}/mcp`, apiKey: GOOD_KEY, version: "test" });
    const r = await engine.call("evaluate_formula", { formula: "SUM(A1:A2)", data: { A1: 1, A2: 2 } });
    assert.deepEqual(JSON.parse(text(r)), { tool: "evaluate_formula", args: { formula: "SUM(A1:A2)", data: { A1: 1, A2: 2 } } });
    assert.ok(fake.authHeaders.every((h) => h === `Bearer ${GOOD_KEY}`));
    await engine.close();
  });

  test("create_session with a local path uploads the file as base64", async () => {
    const file = join(dir, "book.xlsx");
    writeFileSync(file, Buffer.from("PK fake xlsx bytes"));
    const engine = createHostedEngine({ mcpUrl: `${fake.url}/mcp`, apiKey: GOOD_KEY, version: "test" });
    const r = await engine.call("create_session", { path: file, document_id: "Model" });
    const echoed = JSON.parse(text(r));
    assert.equal(echoed.args.path, undefined);
    assert.equal(Buffer.from(echoed.args.base64, "base64").toString(), "PK fake xlsx bytes");
    assert.equal(echoed.args.document_id, "Model");
    await engine.close();
  });

  test("no API key: a clear tool error, and no request is made", async () => {
    const before = fake.authHeaders.length;
    const engine = createHostedEngine({ mcpUrl: `${fake.url}/mcp`, apiKey: undefined, version: "test" });
    const e = errorPayload(await engine.call("list_sessions", {}));
    assert.equal(e.code, "missing_api_key");
    assert.match(e.message, /BASIS_API_KEY/);
    assert.equal(fake.authHeaders.length, before);
  });

  test("a rejected key comes back as unauthorized without echoing the key", async () => {
    const wrong = "basis_wrong_key_123";
    const engine = createHostedEngine({ mcpUrl: `${fake.url}/mcp`, apiKey: wrong, version: "test" });
    const r = await engine.call("list_sessions", {});
    const e = errorPayload(r);
    assert.equal(e.code, "unauthorized");
    assert.ok(!text(r).includes(wrong));
    await engine.close();
  });

  test("an unreachable API is a network_error tool result, and the next call retries", async () => {
    const engine = createHostedEngine({ mcpUrl: "http://127.0.0.1:9/mcp", apiKey: GOOD_KEY, version: "test", timeoutMs: 5_000 });
    assert.equal(errorPayload(await engine.call("list_sessions", {})).code, "network_error");
    assert.equal(errorPayload(await engine.call("list_sessions", {})).code, "network_error");
    await engine.close();
  });

  test("a missing local file is a tool error naming the file", async () => {
    const engine = createHostedEngine({ mcpUrl: `${fake.url}/mcp`, apiKey: GOOD_KEY, version: "test" });
    const e = errorPayload(await engine.call("create_session", { path: join(dir, "missing.xlsx") }));
    assert.equal(e.code, "ENOENT");
    assert.match(e.message, /missing\.xlsx/);
  });

  test("withUploadedPath refuses path together with another source", async () => {
    await assert.rejects(withUploadedPath({ path: "a.xlsx", url: "https://x.test/a.xlsx" }), /at most one/);
    await assert.rejects(withUploadedPath({ path: "a.xlsx", library_file_id: "f1" }), /at most one/);
    assert.deepEqual(await withUploadedPath({ base64: "AA==" }), { base64: "AA==" });
  });
});
