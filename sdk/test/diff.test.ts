import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRecords, type WorkbookDiff } from "../src/diff.ts";
import type { StreamRecord } from "../src/types.ts";

// Minimal record builders — just enough shape for the diff to key and compare.
function sheet(index: number, title: string): StreamRecord {
  return {
    type: "sheet",
    index,
    title,
    state: "visible",
    nrows: 0,
    ncells: 0,
    merged: [],
    hidden_rows: [],
    hidden_cols: [],
    comments: [],
    data_tables: [],
  };
}

interface CellOpts {
  num?: number | null;
  str?: string | null;
  formula?: string | null;
  fmt?: string | null;
  err?: string | null;
  kind?: StreamRecord extends { type: "cell"; kind: infer K } ? K : never;
}

function cell(sheetIndex: number, ref: string, o: CellOpts = {}): StreamRecord {
  return {
    type: "cell",
    sheet: sheetIndex,
    ref,
    kind: o.kind ?? (o.formula ? "formula_number" : o.str != null ? "string" : "number"),
    num: o.num ?? null,
    str: o.str ?? null,
    formula: o.formula ?? null,
    fmt: o.fmt ?? null,
    err: o.err ?? null,
  };
}

function findChanged(diff: WorkbookDiff, ref: string) {
  return diff.changed.find((c) => c.ref === ref);
}

test("added, removed, and unchanged cells", () => {
  const before = [sheet(0, "Sheet1"), cell(0, "A1", { num: 1 }), cell(0, "A2", { num: 2 })];
  const after = [sheet(0, "Sheet1"), cell(0, "A1", { num: 1 }), cell(0, "A3", { num: 3 })];
  const diff = diffRecords(before, after);

  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.changed, 0);
  assert.equal(diff.added[0].ref, "A3");
  assert.equal(diff.removed[0].ref, "A2");
});

test("value change is classified as value", () => {
  const before = [sheet(0, "Sheet1"), cell(0, "A1", { num: 5 })];
  const after = [sheet(0, "Sheet1"), cell(0, "A1", { num: 6 })];
  const diff = diffRecords(before, after);

  assert.equal(diff.summary.changed, 1);
  const c = findChanged(diff, "A1");
  assert.equal(c?.change_kind, "value");
  assert.equal(c?.from.num, 5);
  assert.equal(c?.to.num, 6);
});

test("formula change with same value is classified as formula", () => {
  const before = [sheet(0, "Sheet1"), cell(0, "A1", { num: 5, formula: "B1" })];
  const after = [sheet(0, "Sheet1"), cell(0, "A1", { num: 5, formula: "C1" })];
  const diff = diffRecords(before, after);

  const c = findChanged(diff, "A1");
  assert.equal(c?.change_kind, "formula");
});

test("both value and formula changing is value+formula", () => {
  const before = [sheet(0, "Sheet1"), cell(0, "A1", { num: 5, formula: "B1" })];
  const after = [sheet(0, "Sheet1"), cell(0, "A1", { num: 9, formula: "B1*2" })];
  const diff = diffRecords(before, after);

  assert.equal(findChanged(diff, "A1")?.change_kind, "value+formula");
});

test("format-only change lands in format_changed, not changed", () => {
  const before = [sheet(0, "Sheet1"), cell(0, "A1", { num: 0.5, fmt: "0.00%" })];
  const after = [sheet(0, "Sheet1"), cell(0, "A1", { num: 0.5, fmt: "0.0%" })];
  const diff = diffRecords(before, after);

  assert.equal(diff.summary.changed, 0);
  assert.equal(diff.summary.format_only, 1);
  assert.equal(diff.format_changed[0].from_fmt, "0.00%");
  assert.equal(diff.format_changed[0].to_fmt, "0.0%");
});

test("includeFormat:false suppresses format-only changes", () => {
  const before = [sheet(0, "Sheet1"), cell(0, "A1", { num: 0.5, fmt: "0.00%" })];
  const after = [sheet(0, "Sheet1"), cell(0, "A1", { num: 0.5, fmt: "0.0%" })];
  const diff = diffRecords(before, after, { includeFormat: false });

  assert.equal(diff.summary.format_only, 0);
  assert.equal(diff.format_changed.length, 0);
});

test("diff keys on sheet title, not index — reordered sheets still match", () => {
  const before = [sheet(0, "Revenue"), sheet(1, "Costs"), cell(0, "A1", { num: 100 }), cell(1, "A1", { num: 40 })];
  // Same sheets, swapped order: Costs is now index 0, Revenue index 1.
  const after = [sheet(0, "Costs"), sheet(1, "Revenue"), cell(1, "A1", { num: 100 }), cell(0, "A1", { num: 40 })];
  const diff = diffRecords(before, after);

  assert.equal(diff.summary.added, 0);
  assert.equal(diff.summary.removed, 0);
  assert.equal(diff.summary.changed, 0);
});

test("added/removed sheets are reported by title", () => {
  const before = [sheet(0, "Sheet1"), sheet(1, "Old")];
  const after = [sheet(0, "Sheet1"), sheet(1, "New")];
  const diff = diffRecords(before, after);

  assert.deepEqual(diff.summary.sheets_added, ["New"]);
  assert.deepEqual(diff.summary.sheets_removed, ["Old"]);
});

test("changed cells are sorted by A1 ref order (A2 before A10)", () => {
  const before = [sheet(0, "S"), cell(0, "A10", { num: 1 }), cell(0, "A2", { num: 1 })];
  const after = [sheet(0, "S"), cell(0, "A10", { num: 2 }), cell(0, "A2", { num: 2 })];
  const diff = diffRecords(before, after);

  assert.deepEqual(
    diff.changed.map((c) => c.ref),
    ["A2", "A10"],
  );
});
