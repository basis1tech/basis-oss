// The workbook tools' public contract: names, titles, descriptions and input
// schemas, defined once. The local engine (local.ts) and the hosted engine
// (hosted.ts) both register from this catalog, so the tools a client sees
// stay the same whichever engine runs them; only the "where it runs" note in
// each description differs.
import { z, type ZodRawShape, type ZodTypeAny } from "zod";

export type EngineMode = "local" | "hosted";

export interface EngineToolSpec<S extends ZodRawShape> {
  title: string;
  description: string;
  /** Appended to the description when the tool runs on the local engine. */
  localNote?: string;
  /** Appended when the tool runs on the hosted engine. */
  hostedNote?: string;
  /** False when the hosted endpoint doesn't offer this tool yet. */
  hosted: boolean;
  inputSchema: S;
  /** Extra inputs only the hosted engine accepts. */
  hostedInput?: ZodRawShape;
  /**
   * Inputs the stdio server handles itself and strips before the engine sees
   * the call (e.g. `output_path`: the engine returns bytes, the bridge writes
   * the file). Clients see them; the hosted endpoint never does.
   */
  bridgeInput?: ZodRawShape;
}

function spec<S extends ZodRawShape>(s: EngineToolSpec<S>): EngineToolSpec<S> {
  return s;
}

const UPLOADS = "The workbook is uploaded to the Basis API and held there for the session.";

const calcInputShape = z
  .object({
    iterative: z.boolean().describe("Enable iterative calculation (Excel: Enable iterative calculation)"),
    max_iterations: z.number().int().min(1).max(32767).optional().describe("Maximum passes (Excel default 100)"),
    max_change: z.number().positive().optional().describe("Converged once no value moves more than this (Excel default 0.001)"),
  })
  .describe("Iterative-calculation settings for circular models");

const outputPath = {
  output_path: z
    .string()
    .optional()
    .describe(
      "Write the .xlsx to this local path instead of returning it as base64 (recommended: a workbook as base64 is " +
        "very large). The result then carries saved_to rather than file_base64.",
    ),
  overwrite: z.boolean().optional().describe("Allow output_path to replace an existing file (default false: an existing file is an error)"),
};

const sessionId = z.string().describe("Session ID");
const cellRef = z.string().describe('Cell reference, optionally with sheet prefix (e.g. "B4" or "Sheet1!B4")');

export const engineTools = {
  evaluate_formula: spec({
    title: "Evaluate formula",
    description:
      "Evaluate an Excel formula and return the computed result: a quick way to check what a formula " +
      "returns on a few sample values before you put it in a workbook. " +
      'Pass data as a map of cell references to values (e.g. {"A1": 100, "A2": 200, "B1": "hello"}) ' +
      'and a formula string (e.g. "SUM(A1:A2)"). The formula is placed in row 1 of the first column right of ' +
      "your data, so don't reference that cell. A formula that evaluates to an Excel error returns " +
      'type "error" with the code (#VALUE!, #N/A…) as a normal result; a formula that can\'t be parsed or uses an ' +
      "unsupported function is a tool error. Supports 278 Excel functions: math, financial (NPV, IRR, XIRR, PMT, PRICE, YIELD…), " +
      "statistical distributions, regression, lookup, date/time, text, logical, and dynamic arrays " +
      "(FILTER, SORT, UNIQUE, SEQUENCE, CHOOSECOLS, TAKE, DROP). " +
      "Array expressions evaluate element by element inside SUMPRODUCT, LOOKUP, AGGREGATE, SMALL/LARGE, MATCH and INDEX. " +
      "To check formulas that already live in a workbook, use create_session instead.",
    localNote: "No file or API key needed — runs entirely on this machine.",
    hostedNote: "Runs on the Basis API (needs an API key).",
    hosted: true,
    inputSchema: {
      formula: z.string().describe('Excel formula to evaluate (without the leading \'=\'), e.g. "SUM(A1:A2)" or "NPV(0.08,B1:B5)"'),
      data: z
        .record(z.union([z.number(), z.string(), z.boolean()]))
        .optional()
        .describe('Cell data to populate before evaluating. Keys are cell references like "A1", "B2". Values can be numbers, strings, or booleans.'),
    },
  }),

  create_session: spec({
    title: "Create session",
    description:
      "Create a persistent computation session for a workbook. Pass path/base64/url for xlsx input, or omit all for a blank model. " +
      "Returns a session_id for subsequent calls. The workbook is recalculated on load, including formulas " +
      "written by other tools that carry no cached values, so open a file you have edited to read back what its " +
      "formulas compute (get_outputs, get_formula_range), or change inputs with set_inputs.",
    localNote: "The session lives in this process on this machine; nothing is uploaded.",
    hostedNote: `${UPLOADS} Pass library_file_id instead to open a file from your Library.`,
    hosted: true,
    inputSchema: {
      path: z.string().optional().describe("Local filesystem path to an .xlsx file"),
      base64: z.string().optional().describe("Base64-encoded .xlsx file bytes"),
      url: z.string().url().optional().describe("URL to fetch the .xlsx file from"),
      document_id: z.string().optional().describe("Display label for this session"),
      calc: calcInputShape.optional(),
    },
    hostedInput: {
      library_file_id: z.string().optional().describe("Library file ID to load"),
    },
  }),

  close_session: spec({
    title: "Close session",
    description: "Close a computation session and release its resources.",
    hosted: true,
    inputSchema: { session_id: z.string().describe("Session ID to close") },
  }),

  list_sessions: spec({
    title: "List sessions",
    description: "List all active computation sessions.",
    hosted: true,
    inputSchema: {},
  }),

  add_sheet: spec({
    title: "Add sheet",
    description:
      "Add a new sheet to a session's workbook. The new sheet becomes the active sheet. " +
      "Only works on sessions created from blank documents (not imported xlsx files).",
    hosted: true,
    inputSchema: { session_id: sessionId, name: z.string().describe("Display name for the new sheet") },
  }),

  rename_sheet: spec({
    title: "Rename sheet",
    description:
      "Rename a sheet in a session's workbook. Formulas, named ranges and validations that reference " +
      "the sheet are rewritten to the new name, so results don't change. Excel's rules apply: 1-31 " +
      "characters, none of : \\ / ? * [ ], no leading or trailing apostrophe, unique ignoring case.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      sheet_index: z.number().int().min(0).describe("0-based index of the sheet to rename"),
      name: z.string().describe("New display name for the sheet"),
    },
  }),

  set_inputs: spec({
    title: "Set inputs",
    description:
      "Set one or more cells in a session and recalculate. Keys can be defined names or cell references. " +
      'A string starting with "=" is stored as a formula, so you can also try a formula in place and read the result ' +
      "with get_outputs. Returns applied changes and which named outputs changed (effects).",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      inputs: z.record(z.union([z.number(), z.string(), z.boolean()])).describe('Map of name-or-ref to value. Example: {"Revenue": 1000000}'),
    },
  }),

  set_calc_settings: spec({
    title: "Set calc settings",
    description:
      "Turn iterative calculation on or off for a session and recalculate. Needed for circular models " +
      "(e.g. development pro formas where loan size depends on cost, which includes the loan's interest and fees): " +
      "with it on, set_inputs re-converges the loop on every call. Saved with the session's next commit " +
      "(restore_session to an earlier commit rolls it back) and written to the workbook, so an exported xlsx iterates in Excel too.",
    hosted: true,
    inputSchema: { session_id: sessionId, ...calcInputShape.shape },
  }),

  get_outputs: spec({
    title: "Get outputs",
    description:
      "Read computed values from a session, e.g. to check what the formulas in a workbook return. " +
      'Pass defined names, cell refs ("B4", "Sheet1!B4") or ranges ("Sheet1!H2:H18", one entry per cell), ' +
      'or omit to read all defined names. A cell that evaluates to an Excel error is returned with type "error", not as a tool failure.',
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      names: z
        .array(z.string())
        .optional()
        .describe('Defined names, cell refs or ranges to read, e.g. ["Revenue", "B4", "Sheet1!H2:H18"]'),
    },
  }),

  define_variable: spec({
    title: "Define variable",
    description: "Create or retarget a named variable in the session's workbook.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      name: z.string().describe('Variable name (e.g. "Revenue")'),
      refers_to: z.string().describe('Cell reference (e.g. "Sheet1!$A$1")'),
      scope_sheet: z.number().int().optional().describe("Sheet index for sheet-scoped name"),
    },
  }),

  inspect_model: spec({
    title: "Inspect model",
    description: "Inspect a session's model structure: sheets, defined names, stats, and optionally dependency edges.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      include_edges: z.boolean().optional().default(false).describe("Include the formula dependency graph"),
    },
  }),

  get_cell_formula: spec({
    title: "Get cell formula",
    description:
      "Read the formula source text and computed value for a single cell in a session. " +
      "Returns whether the cell contains a formula, the formula text (with = prefix), " +
      "the computed value, and value type. Use to inspect what a cell actually computes.",
    hosted: true,
    inputSchema: { session_id: sessionId, cell: cellRef },
  }),

  trace_dependencies: spec({
    title: "Trace dependencies",
    description:
      "Trace the formula dependency graph for a cell in a session. Returns precedents " +
      "(cells this cell references) and/or dependents (cells that reference this cell), " +
      "with their formulas and values. Use to understand calculation chains, debug " +
      "circular refs, and find the root cause of errors.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      cell: cellRef,
      direction: z
        .enum(["precedents", "dependents", "both"])
        .optional()
        .default("both")
        .describe('Which direction to trace (default "both")'),
      depth: z.number().int().min(1).max(5).optional().default(1).describe("How many levels deep to trace (default 1, max 5)"),
    },
  }),

  audit_workbook: spec({
    title: "Audit workbook",
    description:
      "Run a comprehensive audit of a session's workbook. Returns statistics on sheets, " +
      "cells, formulas, errors, named ranges, and the dependency graph. Use to get an " +
      "overview of model structure before making changes.",
    hosted: true,
    inputSchema: { session_id: sessionId },
  }),

  get_formula_range: spec({
    title: "Get formula range",
    description:
      "Batch-read formulas and computed values for a rectangular range of cells: the way to check what the " +
      "formulas in a file compute. Returns an array of {cell, formula, value, value_type} for each cell in the range; " +
      'a formula that errors has value_type "error". Much more efficient than calling get_cell_formula repeatedly.',
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      range: z.string().describe('Range address, e.g. "A1:D10" or "Sheet1!B2:F2"'),
    },
  }),

  commit_session: spec({
    title: "Commit session",
    description:
      "Create a named checkpoint of the session's current state. " +
      "Returns the commit ID which can be passed to restore_session to roll back. " +
      "Checkpoints live in the session only; to keep one in the Library's version history, " +
      "call save_to_library after it (the version takes this message as its name).",
    hosted: true,
    inputSchema: { session_id: sessionId, message: z.string().describe("Short description of the checkpoint") },
  }),

  restore_session: spec({
    title: "Restore session",
    description:
      "Roll back a session to a previous commit. Reverts all cell changes made since that commit. " +
      "Returns the number of cells that were changed by the rollback.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      commit_id: z.number().int().nonnegative().describe("Commit ID to restore to (from commit_session)"),
    },
  }),

  snapshot_session: spec({
    title: "Snapshot session",
    description: "Export the session's current state as xlsx bytes (base64). Optionally creates a commit first.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      commit_message: z.string().optional().describe("If provided, creates a commit before saving"),
    },
  }),

  export_workbook: spec({
    title: "Export workbook",
    description:
      "Get a session's workbook back as an .xlsx file with every formula's computed value saved in it. " +
      "Recalculates first. Call this when you need the file itself: to give it to the user, or to read it " +
      "with pandas, openpyxl (data_only=True) or any tool that is not Excel. Returns the file and a " +
      "summary of formula errors (#REF!, #DIV/0!, #NAME? with sheet and cell) and of anything that did not " +
      "survive the save. Everything Basis does not model (styles, charts, images, data validation, defined " +
      "names, comments, VBA) is carried over from the original file unchanged.",
    localNote: "Pass output_path to save the file on this machine.",
    hostedNote: "Pass output_path to save the file on this machine.",
    hosted: true,
    inputSchema: { session_id: sessionId },
    bridgeInput: outputPath,
  }),

  recalc_workbook: spec({
    title: "Recalculate workbook",
    description:
      "Recalculate an .xlsx file and return it with the computed values saved in every formula cell. Use this " +
      "after you create or edit a workbook with openpyxl or any other library that writes formulas without " +
      "results: those files have no cached values, so pandas, openpyxl (data_only=True) and other readers " +
      "see empty cells until the file is recalculated. Replaces running LibreOffice recalc.py. Returns the " +
      "file plus a summary of formula errors (#REF!, #DIV/0!, #NAME?, #VALUE!... with sheet and cell) " +
      "and of formulas Basis could not compute: fix those and call again. Styles, charts, images, data " +
      "validation, defined names, comments and VBA are carried over unchanged. Pass exactly one of path, url or base64.",
    localNote:
      "Pass output_path to save the result on this machine (the same path as the input, with overwrite: true, recalculates a file in place).",
    hostedNote:
      `The workbook is uploaded to the Basis API for the recalculation and not kept. ` +
      "Pass output_path to save the result on this machine (the same path as the input, with overwrite: true, recalculates a file in place).",
    hosted: true,
    inputSchema: {
      path: z.string().optional().describe("Local filesystem path to an .xlsx file"),
      base64: z.string().optional().describe("Base64-encoded .xlsx file bytes"),
      url: z.string().url().optional().describe("URL to fetch the .xlsx file from"),
      filename: z.string().optional().describe("Name for the returned file (defaults to workbook.xlsx)"),
    },
    bridgeInput: outputPath,
  }),

  save_to_library: spec({
    title: "Save to Library",
    description:
      "Save the session's workbook to the user's Library for durable storage. " +
      "If the session was loaded from the Library or was previously saved, this creates a new version " +
      "of that file. Otherwise it creates a new Library file. " +
      "Each save is a named version in the Library's history: pass `message`, or it takes the latest " +
      "commit_session message since the last save. commit_session checkpoints themselves stay in the " +
      "session, so save after each step you want kept as a version. " +
      "Requires a Basis API key. Returns the library_file_id.",
    localNote: "Uploads the workbook to your Basis Library.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      name: z.string().optional().describe("File name (defaults to the session's document label)"),
      message: z
        .string()
        .max(500)
        .optional()
        .describe('Name for this version in the Library, e.g. "23 — revised exit cap" (defaults to the latest commit_session message)'),
    },
  }),
} as const;

export type EngineToolName = keyof typeof engineTools;

export type EngineToolArgs<N extends EngineToolName> = z.objectOutputType<(typeof engineTools)[N]["inputSchema"], ZodTypeAny>;

export const ENGINE_TOOL_NAMES = Object.keys(engineTools) as EngineToolName[];

/** The description a client sees for a tool in the given mode. */
export function describeTool(name: EngineToolName, mode: EngineMode): string {
  const s: EngineToolSpec<ZodRawShape> = engineTools[name];
  const note = mode === "local" ? s.localNote : s.hostedNote;
  return note ? `${s.description} ${note}` : s.description;
}

/** The input schema a client sees for a tool in the given mode. */
export function inputSchemaFor(name: EngineToolName, mode: EngineMode): ZodRawShape {
  const s: EngineToolSpec<ZodRawShape> = engineTools[name];
  return mode === "hosted" && s.hostedInput ? { ...s.inputSchema, ...s.hostedInput } : s.inputSchema;
}

/** The input schema a client sees: the engine's inputs plus the ones the stdio server handles itself. */
export function clientSchemaFor(name: EngineToolName, mode: EngineMode): ZodRawShape {
  const s: EngineToolSpec<ZodRawShape> = engineTools[name];
  return { ...inputSchemaFor(name, mode), ...s.bridgeInput };
}

/** The tools an engine in the given mode offers. */
export function toolsFor(mode: EngineMode): EngineToolName[] {
  return ENGINE_TOOL_NAMES.filter((n) => mode === "local" || engineTools[n].hosted);
}
