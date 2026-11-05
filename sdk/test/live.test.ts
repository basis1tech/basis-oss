// Opt-in smoke test against the real API. Skipped unless BASIS_API_KEY is
// set; BASIS_BASE_URL overrides the default https://api.basis1.tech. Each run
// parses one small fixture, which counts against the key's quota. The key is
// never printed: assertion messages below don't include it, and errors are
// reported by code and status only.
//
//   BASIS_API_KEY=basis_live_... npm run test:live
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Basis, BasisError } from "../src/index.ts";

const key = process.env.BASIS_API_KEY;
const baseUrl = process.env.BASIS_BASE_URL || undefined;
const skip = key ? false : "set BASIS_API_KEY to run the live smoke test";
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures/basic.xlsx");

function describeError(err: unknown): string {
  return err instanceof BasisError ? `BasisError code=${err.code} status=${err.status ?? "-"}` : String(err);
}

describe("live API", { skip }, () => {
  const basis = new Basis({ token: key ?? "unused", baseUrl, timeoutMs: 60_000 });

  test("healthz", async () => {
    assert.equal(await basis.healthz(), true);
  });

  test("parse a small workbook end to end", async () => {
    try {
      const records = await basis.parse(readFileSync(fixture));
      assert.equal(records[0]?.type, "workbook_meta");
      assert.ok(records.some((r) => r.type === "cell"));
      assert.ok(records.some((r) => r.type === "audit" && r.finding === "plug_summary"));
    } catch (err) {
      assert.fail(describeError(err));
    }
  });

  test("a wrong key is rejected as unauthorized", async () => {
    const wrong = new Basis({ token: "basis_live_not_a_real_key", baseUrl });
    await assert.rejects(wrong.getJob("00000000-0000-0000-0000-000000000000"), (err: unknown) => {
      assert.ok(err instanceof BasisError, describeError(err));
      assert.equal(err.code, "unauthorized");
      return true;
    });
  });
});
