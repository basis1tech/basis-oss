import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BASE_URL, DEFAULT_MAX_FETCH_BYTES, loadConfig, type Config } from "../src/config.ts";

const SECRET = "basis_live_SECRET_value_123";

function ok(env: Record<string, string>): Config {
  const r = loadConfig(env);
  if (!r.ok) assert.fail(`expected a config, got errors: ${r.errors.join("; ")}`);
  return r.config;
}

function errors(env: Record<string, string>): string[] {
  const r = loadConfig(env);
  if (r.ok) assert.fail("expected config errors");
  return r.errors;
}

describe("config", () => {
  test("defaults: hosted API, no key, default fetch limit", () => {
    const c = ok({});
    assert.equal(c.apiKey, undefined);
    assert.equal(c.baseUrl, DEFAULT_BASE_URL);
    assert.equal(c.mcpUrl, `${DEFAULT_BASE_URL}/mcp`);
    assert.equal(c.maxFetchBytes, DEFAULT_MAX_FETCH_BYTES);
    assert.deepEqual(c.warnings, []);
  });

  test("BASIS_API_KEY is read and trimmed", () => {
    const c = ok({ BASIS_API_KEY: `  ${SECRET}\n` });
    assert.equal(c.apiKey, SECRET);
    assert.equal(c.apiKeySource, "BASIS_API_KEY");
  });

  test("a blank BASIS_API_KEY counts as unset", () => {
    assert.equal(ok({ BASIS_API_KEY: "   " }).apiKey, undefined);
  });

  test("legacy BASIS_TOKEN still works, with a deprecation warning that doesn't echo the key", () => {
    const c = ok({ BASIS_TOKEN: SECRET });
    assert.equal(c.apiKey, SECRET);
    assert.equal(c.apiKeySource, "BASIS_TOKEN");
    assert.equal(c.warnings.length, 1);
    assert.match(c.warnings[0]!, /BASIS_TOKEN is deprecated/);
    assert.ok(!c.warnings[0]!.includes(SECRET));
  });

  test("BASIS_API_KEY wins over BASIS_TOKEN", () => {
    const c = ok({ BASIS_API_KEY: "new", BASIS_TOKEN: "old" });
    assert.equal(c.apiKey, "new");
    assert.deepEqual(c.warnings, []);
  });

  test("base URL override drops trailing slashes and derives the MCP endpoint", () => {
    const c = ok({ BASIS_BASE_URL: "https://basis.example.com/api//" });
    assert.equal(c.baseUrl, "https://basis.example.com/api");
    assert.equal(c.mcpUrl, "https://basis.example.com/api/mcp");
  });

  test("plain http is allowed for localhost only", () => {
    assert.equal(ok({ BASIS_BASE_URL: "http://localhost:8080" }).baseUrl, "http://localhost:8080");
    assert.equal(ok({ BASIS_BASE_URL: "http://127.0.0.1:8080" }).baseUrl, "http://127.0.0.1:8080");
    const [e] = errors({ BASIS_BASE_URL: "http://api.example.com" });
    assert.match(e!, /must use https:\/\/ unless it points at localhost/);
  });

  test("rejects a base URL that isn't a URL", () => {
    assert.match(errors({ BASIS_BASE_URL: "api.basis1.tech" })[0]!, /not a valid URL/);
  });

  test("rejects non-http schemes", () => {
    assert.match(errors({ BASIS_BASE_URL: "ftp://api.basis1.tech" })[0]!, /must start with https:\/\//);
  });

  test("rejects credentials or a query in the base URL", () => {
    assert.match(errors({ BASIS_BASE_URL: "https://user:pw@api.basis1.tech" })[0]!, /plain base URL/);
    assert.match(errors({ BASIS_BASE_URL: "https://api.basis1.tech/?x=1" })[0]!, /plain base URL/);
  });

  test("BASIS_MCP_MAX_FETCH_BYTES must be a positive whole number", () => {
    assert.equal(ok({ BASIS_MCP_MAX_FETCH_BYTES: "1000" }).maxFetchBytes, 1000);
    for (const bad of ["0", "-5", "1.5", "lots", "1e400"]) {
      assert.match(errors({ BASIS_MCP_MAX_FETCH_BYTES: bad })[0]!, /positive whole number/, bad);
    }
  });

  test("reports every problem at once, and never the key", () => {
    const errs = errors({ BASIS_API_KEY: SECRET, BASIS_BASE_URL: "nope", BASIS_MCP_MAX_FETCH_BYTES: "x" });
    assert.equal(errs.length, 2);
    for (const e of errs) assert.ok(!e.includes(SECRET));
  });
});
