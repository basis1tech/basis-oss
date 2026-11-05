// The wire contract documented in docs/api-stream-v1.html and
// docs/openapi.yaml, mirroring `write_record_json` in core/src/stream.rs.
// test/contract.test.ts runs the engine on fixture workbooks and checks every
// emitted record against these types, so a field added in Rust fails CI here.

export type StreamNumberValue = number | "NaN" | "Infinity" | "-Infinity" | null;

export interface StreamDefinedName {
  name: string;
  refers_to: string;
  scope: number | null;
  is_builtin: boolean;
  is_broken: boolean;
  usable: boolean;
}

export interface StreamComment {
  cell: string;
  author: string | null;
  text: string;
  ts: string | null;
  kind: string; // "threaded" | "legacy" | "gsheets"
}

export interface StreamDataTable {
  cell: string;
  ref: string;
  row_input: string;
  col_input: string;
  two_dimensional: boolean;
}

export type StreamCellKind =
  | "number"
  | "string"
  | "bool"
  | "error"
  | "formula_number"
  | "formula_other";

export type StreamEdgeKind =
  | "cell"
  | "range"
  | "named"
  | "error"
  | "data_table_input";

/** Per-kind plug tallies (`by_kind_json` in core/src/audit.rs). */
export interface StreamPlugCounts {
  constant_in_formula_run: number;
  formula_deviation: number;
}

export type StreamAuditFinding =
  | {
      finding: "verification";
      formula_cells: number;
      compared: number;
      mismatches: number;
      coverage_pct: number;
      errors: number;
      unsupported: number;
      unsupported_breakdown: { reason: string; count: number }[];
      mismatch_samples: {
        sheet: number;
        sheet_name: string;
        ref: string;
        cached: StreamNumberValue;
        computed: StreamNumberValue;
      }[];
    }
  | {
      finding: "plug";
      sheet: number;
      sheet_name: string;
      ref: string;
      kind: keyof StreamPlugCounts;
      value: string;
      expected: string;
      axis: "row" | "column";
    }
  | {
      finding: "plug_summary";
      emitted: number;
      total: number;
      /** Counts over every plug found, not just the `emitted` sample. */
      by_kind: StreamPlugCounts;
      cap: number;
      truncated: boolean;
    }
  | {
      finding: "broken_ref";
      sheet: number;
      sheet_name: string;
      ref: string;
      raw: string;
    }
  | {
      finding: "cycles";
      count: number;
      iterative_calc: boolean;
      sanctioned: boolean;
      members: { sheet_name: string; ref: string }[];
    }
  | {
      finding: "staleness";
      volatile_cells: number;
      external_refs: number;
      hidden_sheets: string[];
      hidden_rows: number;
      hidden_cols: number;
    };

export type StreamRecord =
  | {
      type: "workbook_meta";
      date_system: "1900" | "1904";
      calc_iterative: boolean;
      calc_count: number | null;
      has_vba: boolean;
      sheet_count: number;
      core_properties: Record<string, string>;
      defined_names: StreamDefinedName[];
    }
  | {
      type: "sheet";
      index: number;
      title: string;
      state: string; // "visible" | "hidden" | "veryHidden"
      nrows: number;
      ncells: number;
      merged: string[];
      hidden_rows: number[];
      hidden_cols: number[];
      comments: StreamComment[];
      data_tables: StreamDataTable[];
    }
  | {
      type: "cell";
      sheet: number;
      ref: string;
      kind: StreamCellKind;
      num: StreamNumberValue;
      str: string | null;
      formula: string | null;
      fmt: string | null;
      err: string | null;
    }
  | {
      type: "edge";
      src_sheet: string;
      src_cell: string;
      tgt_sheet: string | null;
      tgt_ref: string;
      raw: string;
      named_ref: string | null;
      kind: StreamEdgeKind;
      is_range: boolean;
      is_cross_sheet: boolean;
      is_external: boolean;
      is_ref_error: boolean;
    }
  | {
      type: "image";
      sheet: number;
      index: number;
      anchor: "two_cell" | "one_cell" | "absolute";
      from: string | null;
      to: string | null;
      ext_cx_emu: number | null;
      ext_cy_emu: number | null;
      col_off_emu: number | null;
      row_off_emu: number | null;
      mime: string;
      sha256: string;
      byte_len: number;
      alt: string | null;
      data_base64: string | null;
    }
  | {
      type: "image_summary";
      total_images: number;
      total_bytes: number;
      inlined: number;
    }
  | ({ type: "audit" } & StreamAuditFinding);

// Job envelopes returned by POST /v1/jobs (202 shape) and GET /v1/jobs/:id.
export type JobLifecycleStatus = "processing" | "completed" | "failed";

export interface Job {
  job_id: string;
  status: JobLifecycleStatus;
  status_url: string;
  stream_url: string;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobStatus {
  job_id: string;
  status: JobLifecycleStatus;
  created_at: string;
  updated_at: string;
  expires_at: string;
  bytes_in: number;
  records_out: number | null;
  stream_url: string;
  sheets_url: string | null;
  error: JobError | null;
}

// One entry per sheet, returned by GET /v1/jobs/:id/sheets once the job has
// completed — see sdk's listJobSheets().
export interface SheetInfo {
  index: number;
  title: string;
  state: string; // "visible" | "hidden" | "veryHidden"
  cell_count: number;
  image_count: number;
  stream_url: string;
}

// Returned by POST /v1/library/save (201 when a version was written, 200 with
// `noop: true` when the bytes matched the latest version).
export interface LibrarySaveResult {
  library_file_id: string;
  version_id: string;
  name: string;
  message: string;
  /** True when this call created a new Library file rather than a version. */
  created: boolean;
  /** True when nothing changed, so no new version was written. */
  noop: boolean;
}

// ---- recalc / export -------------------------------------------------------

/** A formula cell that evaluated to an error. */
export interface FormulaErrorCell {
  sheet: string;
  cell: string;
  /** `#REF!`, `#DIV/0!`, `#NAME?`, `#VALUE!`, ... */
  error: string;
  /** With the leading `=`. */
  formula: string;
}

/** A formula Basis could not compute, so the file has no cached value for it. */
export interface UncomputedCell {
  sheet: string;
  cell: string;
  formula: string;
}

/** Content the round trip could not keep intact, or a result to double-check. */
export interface ExportWarning {
  /** `rich_text_flattened`, `data_table_dropped`, `array_formula_not_recomputed`, `formulas_not_computed`. */
  code: string;
  message: string;
}

/** What to fix before relying on a recalculated workbook. */
export interface ExportSummary {
  /** True when no formula is an error and none is left without a value. */
  ok: boolean;
  formula_cells: number;
  /** True for an `.xlsm`: the VBA project is carried over untouched. */
  macro_enabled: boolean;
  error_total: number;
  /** Count per error literal, e.g. `{ "#DIV/0!": 2 }`. */
  error_counts: Record<string, number>;
  /** Up to 200 of the error cells. */
  errors: FormulaErrorCell[];
  uncomputed_total: number;
  /** Up to 200 of the cells without a computed value. */
  uncomputed: UncomputedCell[];
  warnings: ExportWarning[];
}

/** A workbook file with computed values saved in it, from `recalc` or `exportSession`. */
export interface ExportedWorkbook {
  /** `.xlsx`, or `.xlsm` for a macro-enabled workbook. */
  filename: string;
  contentType: string;
  /** The file. */
  bytes: Uint8Array;
  summary: ExportSummary;
}
