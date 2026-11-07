// The workbook tools' public contract: names, titles, descriptions and input
// schemas, defined once. The local engine (local.ts) and the hosted engine
// (hosted.ts) both register from this catalog, so the tools a client sees
// stay the same whichever engine runs them; only the "where it runs" note in
// each description differs.
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
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

const sessionId = z.string().describe("Session ID returned by create_session (list_sessions shows the open ones)");
const cellRef = z.string().describe('Cell reference, optionally with sheet prefix (e.g. "B4" or "Sheet1!B4")');

export const engineTools = {
  evaluate_formula: spec({
    title: "Evaluate formula",
    description:
      "Evaluate an Excel formula and return the computed result: a quick way to check what a formula " +
      "returns on a few sample values before you put it in a workbook. " +
      'Pass data as a map of cell references to values (e.g. {"A1": 100, "A2": true, "A3": "#N/A", "B1": "hello"}) ' +
      'and a formula string (e.g. "SUM(A1:A2)"). Values keep their Excel types, as in a workbook: true/false are ' +
      "logical cells (so SUM, AVERAGE and COUNT skip them in a range), a string that is exactly an error code " +
      "(#N/A, #DIV/0!, #VALUE!, #REF!, #NAME?, #NUM!, #NULL!) is that error, and other strings are text. The " +
      "formula is placed in row 1 of the first column right of " +
      'your data, so don\'t reference that cell. Returns {formula, result, type, stats}, type being "number", ' +
      '"string", "boolean" or "error". A formula that evaluates to an Excel error returns ' +
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
        .describe(
          'Cell data to populate before evaluating. Keys are cell references like "A1", "B2". ' +
            'Values are numbers, booleans (logical TRUE/FALSE), error codes such as "#N/A", or text.',
        ),
    },
  }),

  create_session: spec({
    title: "Create session",
    description:
      "Open a workbook in a session that the other workbook tools then use by session_id: the starting point for " +
      "reading, editing, recalculating and exporting a model. Pass at most one of path, base64 (raw .xlsx bytes) or " +
      "url, or none for a blank workbook (the only kind add_sheet can extend). The workbook is recalculated on " +
      "load, including formulas written by other tools without cached values, so opening a file you edited " +
      "elsewhere is how you read back what its formulas compute (get_outputs, get_formula_range); change inputs " +
      "with set_inputs. Returns {session_id, document_id, library_file_id, sheets: [{index, name}], defined_names, " +
      "calc}. For a one-off recalculation of a file, use recalc_workbook instead; to try a formula without a file, " +
      "use evaluate_formula.",
    localNote: "The session lives in this process on this machine; nothing is uploaded.",
    hostedNote:
      `${UPLOADS} Pass library_file_id instead to open a file from your Library. ` +
      "Each API key can hold 5 open sessions, and a session closes on its own after 30 minutes without a call. " +
      "A sixth create_session fails with max_sessions and lists the open sessions; close one first. " +
      "save_to_library keeps the workbook beyond the session.",
    hosted: true,
    inputSchema: {
      path: z.string().optional().describe("Local filesystem path to an .xlsx file"),
      base64: z.string().optional().describe("Base64-encoded .xlsx file bytes"),
      url: z.string().url().optional().describe("Public https URL to fetch the .xlsx file from (private and local addresses are refused)"),
      document_id: z.string().optional().describe("Display label for this session"),
      calc: calcInputShape.optional(),
    },
    hostedInput: {
      library_file_id: z.string().optional().describe("ID of a Library file to open (library_file_id from save_to_library or an earlier session)"),
    },
  }),

  close_session: spec({
    title: "Close session",
    description:
      "End a session and discard its workbook: the session_id stops working and the session can't be reopened. " +
      "Edits not saved with save_to_library (or downloaded with export_workbook) are lost, and its commit_session " +
      "checkpoints go with it, so restore_session can't bring it back. Call it when you're done with a workbook, or " +
      "to free a slot when create_session fails with max_sessions. Returns {closed: true}, plus unsaved: true and a " +
      "hint when the workbook was edited since it was opened or last saved to the Library. An unknown, expired or already closed " +
      "session_id fails with session_not_found, which lists the sessions still open.",
    hostedNote:
      "Sessions also close on their own after 30 minutes without a call.",
    hosted: true,
    inputSchema: { session_id: z.string().describe("ID of the session to close, from create_session or list_sessions") },
  }),

  list_sessions: spec({
    title: "List sessions",
    description:
      "List the sessions open for this API key, to recover a session_id you've lost or to see how many are open " +
      "before create_session. Returns {sessions: [{id, documentId, libraryFileId, createdAt, updatedAt, sheetCount, " +
      "memBytes}]}, times in epoch milliseconds; closed and expired sessions are left out. Pass an id to any " +
      "session tool, or to close_session to free a slot. Takes no arguments.",
    hostedNote:
      "Each API key can hold 5 open sessions, and a session closes on its own after 30 minutes without a call.",
    hosted: true,
    inputSchema: {},
  }),

  add_sheet: spec({
    title: "Add sheet",
    description:
      "Add an empty sheet at the end of a session's workbook and make it the active sheet (the one unqualified refs " +
      "like \"B4\" point to). Only for sessions created blank (create_session with no file); on an imported workbook " +
      "it fails, so work in its existing sheets with set_inputs instead. To retitle a sheet use rename_sheet; to " +
      "remove one use delete_sheet. Returns {sheet_index, sheet_name, sheet_count}.",
    hosted: true,
    inputSchema: { session_id: sessionId, name: z.string().describe("Name for the new sheet tab, e.g. \"Assumptions\"") },
  }),

  rename_sheet: spec({
    title: "Rename sheet",
    description:
      "Rename a sheet in a session's workbook, found by its 0-based index (see the sheets list from create_session " +
      "or inspect_model). Formulas, named ranges and validations that reference the sheet are rewritten to the new " +
      "name, so results don't change; use it rather than add_sheet when you only need a different title. Excel's " +
      "rules apply: 1-31 characters, none of : \\ / ? * [ ], no leading or trailing apostrophe, unique ignoring " +
      "case; a name that breaks them, or an index past the last sheet, fails with bad_request. Returns " +
      "{sheet_index, previous_name, sheet_name}.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      sheet_index: z.number().int().min(0).describe("0-based index of the sheet to rename"),
      name: z.string().describe("New display name for the sheet"),
    },
  }),

  delete_sheet: spec({
    title: "Delete sheet",
    description:
      "Delete a sheet from a session's workbook, found by its 0-based index (see the sheets list from " +
      "create_session or inspect_model), the way Excel does: formulas on other sheets that referenced it now read " +
      "#REF! (Gone!A1 becomes #REF!A1) and evaluate to #REF!, a 3D range ending on it (Jan:Mar!B2) shrinks to the " +
      "neighbouring sheet, names scoped to it are removed and names that pointed into it refer to #REF!. Sheets " +
      "after it move down one index, so re-read indexes from the result before the next call. Works on imported " +
      "and blank workbooks, and recalculates. It can't be undone: restore_session brings back other cells but not " +
      "the sheet, so export_workbook or save_to_library first if you may need it. Returns {deleted: {sheet_index, " +
      "sheet_name}, sheets: [{index, name}], active_sheet, formulas_broken (up to 200 cell refs), " +
      "formulas_broken_count, names_removed, names_broken}. The last sheet, the last visible sheet or an index " +
      "past the last sheet fails with bad_request and changes nothing. To retitle a sheet use rename_sheet; to " +
      "empty one without breaking references, overwrite its cells with set_inputs.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      sheet_index: z.number().int().min(0).describe("0-based index of the sheet to delete"),
    },
  }),

  set_inputs: spec({
    title: "Set inputs",
    description:
      "Write values or formulas into cells of a session and recalculate: the way to run a scenario on a model " +
      "(\"what if Revenue is 1.2M?\"). Keys are defined names (e.g. \"Revenue\") or cell refs (\"B4\" on the active " +
      "sheet, \"Sheet1!A1\"); values are numbers, booleans (logical TRUE/FALSE), error codes such as \"#N/A\", text, " +
      "or a string starting with \"=\" to store a formula. Whatever the target cells held before is overwritten, so call commit_session first if you " +
      "may want restore_session to undo it. The batch is all or nothing: a key that isn't a defined name or valid " +
      "ref, or a formula that can't be stored, fails the call with invalid_input and no cell is written. Returns {applied, recalc, effects}: the cells " +
      "written, recalc stats (with a warning for circular references that didn't converge) and each defined name " +
      "whose value changed, with before and after. Read other results with get_outputs; to try a formula without " +
      "touching the workbook use evaluate_formula; to create a name use define_variable.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      inputs: z.record(z.union([z.number(), z.string(), z.boolean()])).describe('Map of defined name or cell ref to value; a string starting with "=" is stored as a formula. Example: {"Revenue": 1000000, "Sheet1!B4": "=B2*1.1"}'),
    },
  }),

  set_calc_settings: spec({
    title: "Set calc settings",
    description:
      "Turn iterative calculation on or off for a session and recalculate. Needed for circular models (e.g. " +
      "development pro formas where loan size depends on cost, which includes the loan's interest and fees): with " +
      "it on, set_inputs re-converges the loop on every call. Saved with the session's next commit (restore_session " +
      "to an earlier commit rolls it back) and written to the workbook, so an exported xlsx iterates in Excel too. " +
      "Returns {calc, recalc}: the settings now in force and whether the model converged.",
    hosted: true,
    inputSchema: { session_id: sessionId, ...calcInputShape.shape },
  }),

  get_outputs: spec({
    title: "Get outputs",
    description:
      "Read computed values from a session by defined name, cell or range: the way to check what a model's formulas " +
      "return, e.g. after set_inputs. Pass names as defined names, cell refs (\"B4\", \"Sheet1!B4\") or ranges " +
      "(\"Sheet1!H2:H18\", up to 2,000 cells, one entry per cell); omit names to read every defined name. Returns " +
      "{values: {<name or ref>: {cell, type, value}}}; a cell holding an Excel error comes back with type \"error\" " +
      "and its code, not as a tool failure, while a key that isn't a defined name or valid ref fails the call. " +
      "Values only: for formula text use get_formula_range, and to see what feeds a value use " +
      "trace_dependencies.",
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
    description:
      "Create a defined name for a cell, or repoint an existing one, so set_inputs and get_outputs can use a " +
      "readable key (\"Revenue\") instead of a cell ref. A name that already exists in the same scope is overwritten " +
      "with the new target; no cell's value or formula changes. Names follow Excel's rules (start with a letter, _ " +
      "or \\, no spaces, not a cell ref) and invalid ones fail the call. Returns {name, refers_to, defined_names}, " +
      "the last being every name after the change. To remove a name use delete_variable; to see the existing names " +
      "first, use inspect_model.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      name: z.string().describe('Name to create or repoint, following Excel\'s name rules (e.g. "Revenue", "Exit_Cap")'),
      refers_to: z.string().describe('Cell reference the name points to (e.g. "Sheet1!$A$1")'),
      scope_sheet: z.number().int().optional().describe("0-based sheet index for a sheet-scoped name; omit for workbook scope"),
    },
  }),

  delete_variable: spec({
    title: "Delete variable",
    description:
      "Delete a defined name from a session's workbook, e.g. one you made with define_variable and no longer need. " +
      "Only the name goes; the cell it pointed to keeps its value and formula. Match is by name, ignoring case, in " +
      "workbook scope or, with scope_sheet, the name scoped to that sheet. A name still used by a formula is not " +
      "deleted: the call fails with name_in_use and lists those cells, so rewrite them with set_inputs (or repoint " +
      "the name with define_variable) first. A name that doesn't exist in that scope fails with not_found, and " +
      "Excel's built-in names (print areas, filters) can't be deleted. restore_session doesn't bring a deleted name " +
      "back; define_variable recreates it. Returns {deleted, scope_sheet, defined_names}, the last being every name " +
      "left. To see the names first, use inspect_model.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      name: z.string().min(1).describe('Defined name to delete, e.g. "Exit_Cap" (case doesn\'t matter)'),
      scope_sheet: z.number().int().min(0).optional().describe("0-based sheet index of a sheet-scoped name; omit for a workbook-scoped name"),
    },
  }),

  inspect_model: spec({
    title: "Inspect model",
    description:
      "Summarize a session's structure: each sheet's index, name and used rows and columns, every defined name with " +
      "its target, the iterative-calc settings, and counts of cells, memory, edit events and commits. Use it to " +
      "find your way around a workbook before reading or editing it: sheet indexes for rename_sheet, delete_sheet and " +
      "define_variable, names for get_outputs and set_inputs. include_edges adds every formula dependency edge, " +
      "which is large on big models; to follow the chain from one cell use trace_dependencies instead. For errors, " +
      "plugs and broken references use audit_workbook.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      include_edges: z.boolean().optional().default(false).describe("Also return every formula dependency edge (default false; large on big models)"),
    },
  }),

  trace_dependencies: spec({
    title: "Trace dependencies",
    description:
      "Follow formula references from one cell in a session, breadth first, up to depth levels (1-5): direction " +
      "\"precedents\" walks to the cells it reads, \"dependents\" to the cells that read it, and \"both\" (the " +
      "default) does each. Returns {root, direction, max_depth, levels: [{depth, nodes: [{cell, formula, value, " +
      "value_type}]}]} for one direction, or precedents and dependents (each a levels list) in place of levels for " +
      "\"both\"; ranges are expanded to single cells and each cell is listed once per direction. Use it to explain " +
      "where a number comes from, find the source of an error, or see what an input affects. For a cell's own formula use get_formula_range; for the whole graph at once " +
      "use inspect_model with include_edges.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      cell: cellRef,
      direction: z
        .enum(["precedents", "dependents", "both"])
        .optional()
        .default("both")
        .describe('"precedents" for the cells this cell reads, "dependents" for the cells that read it, "both" for each (default "both")'),
      depth: z.number().int().min(1).max(5).optional().default(1).describe("How many levels deep to trace (default 1, max 5)"),
    },
  }),

  audit_workbook: spec({
    title: "Audit workbook",
    description:
      "Check a session's whole workbook for modeling problems and return a JSON report: broken references, circular " +
      "references and whether they converge, hardcoded plugs (a constant or odd formula breaking a run of " +
      "consistent formulas), external links, volatile functions, hidden sheets and names, stale cached values, and " +
      "a verification block comparing Basis's computed values with the ones Excel last saved. Recalculates first " +
      "and changes nothing else. Use it as a health check before trusting or handing off a model; for structure " +
      "only use inspect_model, for one value's lineage trace_dependencies, and to compare two files diff_workbooks.",
    hosted: true,
    inputSchema: { session_id: sessionId },
  }),

  get_formula_range: spec({
    title: "Get formula range",
    description:
      "Read the formulas and computed values of one cell or a rectangular range in a session: the way to check " +
      "what a cell or a block of cells computes. Pass a single cell (\"B4\", \"Sheet1!B4\") or a range " +
      "(\"A1:D10\"). Returns {worksheet, range, cell_count, cells: [{cell, formula, value, value_type}]}, with " +
      "formula including its leading \"=\" (null for constants and empty cells) and value_type \"number\", " +
      "\"string\", \"boolean\", \"error\" or \"empty\". Read a block in one call rather than cell by cell; to read " +
      "values by defined name use get_outputs, and for the cells that feed one use trace_dependencies. Every cell in the rectangle is returned, up to 2,000 cells a call; a larger range fails with " +
      "range_too_large, so read a big block in pieces. An unknown sheet or malformed range fails the call.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      range: z.string().describe('A cell or range, e.g. "B4", "A1:D10" or "Sheet1!B2:F2"'),
    },
  }),

  commit_session: spec({
    title: "Commit session",
    description:
      "Create a named checkpoint of the session's current state, e.g. before a risky edit. Returns {commit_id, " +
      "message, total_commits}; pass commit_id to restore_session to roll back. Every call adds a new checkpoint. " +
      "Checkpoints live in the session only and are lost when it closes or expires; to keep one in the Library's " +
      "version history, call save_to_library after it (the version takes this message as its name).",
    hosted: true,
    inputSchema: { session_id: sessionId, message: z.string().describe("Short description of the checkpoint, e.g. \"before exit cap change\"; also names the next Library version") },
  }),

  restore_session: spec({
    title: "Restore session",
    description:
      "Roll a session back to a checkpoint from commit_session: every cell edit made after it is undone, calc " +
      "settings included, and the workbook is recalculated. Use it to throw away a what-if or a bad edit; it " +
      "rewinds this session only and can't reopen a closed one. Returns {restored_to, cells_changed, calc, recalc}. " +
      "A commit_id the session doesn't have fails the call. To compare two states without rolling back, export each " +
      "with export_workbook and use diff_workbooks.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      commit_id: z.number().int().nonnegative().describe("Commit ID to restore to (from commit_session)"),
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
      url: z.string().url().optional().describe("Public https URL to fetch the .xlsx file from (private and local addresses are refused)"),
      filename: z.string().optional().describe("Name for the returned file (defaults to workbook.xlsx)"),
    },
    bridgeInput: outputPath,
  }),

  save_to_library: spec({
    title: "Save to Library",
    description:
      "Save the session's workbook to the user's Library for durable storage. If the session was loaded from the " +
      "Library or was previously saved, this creates a new version of that file. Otherwise it creates a new Library " +
      "file. Each save is a named version in the Library's history: pass `message`, or it takes the latest " +
      "commit_session message since the last save. commit_session checkpoints themselves stay in the session, so " +
      "save after each step you want kept as a version. Returns {library_file_id, version_id, name, message, " +
      "created, noop}; noop is true when nothing changed since the last version. Open the file again later with " +
      "create_session's library_file_id; list_library_files finds it.",
    localNote: "Uploads the workbook to your Basis Library.",
    hosted: true,
    inputSchema: {
      session_id: sessionId,
      name: z.string().optional().describe("File name for a new Library file (defaults to the session's document label); not used when saving a new version"),
      message: z
        .string()
        .max(500)
        .optional()
        .describe('Name for this version in the Library, e.g. "23 — revised exit cap" (defaults to the latest commit_session message)'),
    },
  }),

  list_library_files: spec({
    title: "List Library files",
    description:
      "List the workbooks in the user's Library: the files this account owns, newest-updated first, including " +
      "everything save_to_library saved. Use it to find a library_file_id to open with create_session, or to " +
      "check that a save landed. Returns {files: [{library_file_id, name, size_bytes, created_at, updated_at, " +
      "latest_version: {seq, message, created_at}}], truncated}, times in ISO 8601; latest_version is the newest " +
      "saved version and its name. Pass query to match part of a file name (ignoring case) and limit for how many " +
      "to return (1-200, default 50); truncated is true when more files match, so narrow the query or raise limit. " +
      "Shared files and the trash are left out. Fails with library_unavailable when the Library isn't connected.",
    hostedNote: "Reads your Basis Library through the API (needs an API key).",
    hosted: true,
    inputSchema: {
      query: z.string().max(200).optional().describe('Part of a file name to match, ignoring case, e.g. "pro forma" (omit for every file)'),
      limit: z.number().int().min(1).max(200).optional().describe("Most files to return (1-200, default 50)"),
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

const read: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const readExternal: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
const write = (destructive: boolean, idempotent: boolean, openWorld = false): ToolAnnotations => ({
  readOnlyHint: false,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: openWorld,
});

/**
 * Hints that let a client tell a read from a write without asking. A tool
 * that can save a file with output_path counts as a write that may replace a
 * file (only with overwrite: true). Kept in step with the hosted server's
 * server/mcp-annotations.js, which has no output_path.
 */
const toolAnnotations: Record<EngineToolName, ToolAnnotations> = {
  evaluate_formula: read,
  create_session: write(false, false, true),
  close_session: write(true, true),
  list_sessions: read,
  add_sheet: write(false, false),
  rename_sheet: write(false, true),
  delete_sheet: write(true, false),
  set_inputs: write(true, true),
  set_calc_settings: write(false, true),
  get_outputs: read,
  define_variable: write(true, true),
  delete_variable: write(true, true),
  inspect_model: read,
  trace_dependencies: read,
  audit_workbook: read,
  get_formula_range: read,
  commit_session: write(false, false),
  restore_session: write(true, true),
  export_workbook: write(true, true),
  recalc_workbook: write(true, true, true),
  save_to_library: write(false, false, true),
  list_library_files: read,
};

/** The annotations a client sees for a workbook tool. */
export function annotationsFor(name: EngineToolName): ToolAnnotations {
  return toolAnnotations[name];
}

/** Annotations for the parse tools in api-tools.ts. */
export const apiToolAnnotations = {
  parse_workbook: readExternal,
  submit_job: write(false, false, true),
  stream_job: read,
  diff_workbooks: readExternal,
} as const satisfies Record<string, ToolAnnotations>;
