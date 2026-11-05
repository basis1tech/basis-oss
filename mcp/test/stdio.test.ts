// End-to-end over stdio against the built bundle (run `npm run build`
// first): the MCP handshake, startup errors on stderr, and a tool call that
// goes all the way through to a stand-in for the hosted endpoint.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handshake, PROTOCOL_VERSION } from "../scripts/handshake.mjs";
import { GOOD_KEY, startFakeHosted, type FakeHosted } from "./fake-hosted.ts";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

/** The child's env: nothing Basis-related inherited from the developer's shell. */
function env(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("BASIS_")) base[k] = v;
  return { ...base, ...extra };
}

interface Result {
  responses: Array<{ id: number; result?: any; error?: any }>;
  stderr: string;
  stdoutNoise: string[];
  code: number | null;
}

const run = (e: Record<string, string>, requests?: unknown[], args: string[] = []): Promise<Result> =>
  handshake(process.execPath, [BIN, ...args], { env: env(e), requests });

describe("stdio server (dist/index.js)", () => {
  let fake: FakeHosted;
  before(async () => {
    assert.ok(existsSync(BIN), "dist/index.js is missing: run `npm run build` before `npm test`");
    fake = await startFakeHosted();
  });
  after(() => fake.close());

  test("initialize + tools/list: 26 tools, nothing but protocol on stdout", async () => {
    const r = await run({ BASIS_API_KEY: GOOD_KEY });
    assert.deepEqual(r.stdoutNoise, []);
    const [init, list] = r.responses;
    assert.equal(init!.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(init!.result.serverInfo.name, "basis");
    const names: string[] = list!.result.tools.map((t: { name: string }) => t.name);
    assert.equal(names.length, 26);
    for (const n of ["parse_workbook", "diff_workbooks", "evaluate_formula", "create_session", "save_to_library", "rename_sheet", "export_workbook", "recalc_workbook"]) {
      assert.ok(names.includes(n), n);
    }
    assert.match(r.stderr, /ready: 26 tools; workbook tools run on hosted/);
    assert.ok(!r.stderr.includes(GOOD_KEY), "the key must never be logged");
    assert.equal(r.code, 0);
  });

  test("starts without a key, warns on stderr, and tools explain what to do", async () => {
    const r = await run({}, [{ method: "tools/call", params: { name: "evaluate_formula", arguments: { formula: "1+1" } } }]);
    assert.deepEqual(r.stdoutNoise, []);
    assert.match(r.stderr, /BASIS_API_KEY is not set/);
    const call = r.responses[1]!.result;
    assert.equal(call.isError, true);
    assert.equal(JSON.parse(call.content[0].text).code, "missing_api_key");
  });

  test("a workbook tool goes through to the hosted endpoint", async () => {
    const r = await run({ BASIS_API_KEY: GOOD_KEY, BASIS_BASE_URL: fake.url }, [
      { method: "tools/call", params: { name: "evaluate_formula", arguments: { formula: "SUM(A1:A2)", data: { A1: 2, A2: 3 } } } },
    ]);
    const call = r.responses[1]!.result;
    assert.equal(call.isError, undefined, JSON.stringify(call));
    assert.deepEqual(JSON.parse(call.content[0].text), {
      tool: "evaluate_formula",
      args: { formula: "SUM(A1:A2)", data: { A1: 2, A2: 3 } },
    });
    assert.ok(!r.stderr.includes(GOOD_KEY));
  });

  test("bad settings: exits 1 before speaking MCP, with every problem on stderr", async () => {
    const r = await run({ BASIS_API_KEY: GOOD_KEY, BASIS_BASE_URL: "http://api.example.com", BASIS_MCP_MAX_FETCH_BYTES: "lots" });
    assert.equal(r.code, 1);
    assert.deepEqual(r.responses, []);
    assert.deepEqual(r.stdoutNoise, []);
    assert.match(r.stderr, /BASIS_BASE_URL must use https:\/\//);
    assert.match(r.stderr, /BASIS_MCP_MAX_FETCH_BYTES must be a positive whole number/);
    assert.match(r.stderr, /not starting/);
    assert.ok(!r.stderr.includes(GOOD_KEY));
  });

  test("an unknown flag exits 2 with a hint", async () => {
    const r = await run({}, [], ["--port", "8080"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown option --port/);
  });

  test("--version prints the package version", async () => {
    const r = await run({}, [], ["--version"]);
    assert.equal(r.code, 0);
    assert.match(r.stdoutNoise.join("\n"), /^\d+\.\d+\.\d+/);
  });
});
