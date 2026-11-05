// `output_path` for the tools that return a workbook file (export_workbook,
// recalc_workbook). The engines return the file as base64; when the caller
// gives a path, this writes the bytes there and swaps the base64 for
// `saved_to`, so a multi-megabyte workbook never has to pass through the
// model's context. An existing file is never replaced unless `overwrite` is
// true.
import { stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorResult, jsonResult } from "../results.ts";

function firstText(result: CallToolResult): string | undefined {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : undefined;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Runs `call` with `output_path`/`overwrite` removed from the arguments. With
 * a path, the returned file is written there; without one the result passes
 * through unchanged.
 */
export async function withOutputFile(
  args: Record<string, unknown>,
  call: (forward: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const { output_path: outputPath, overwrite, ...forward } = args;
  if (outputPath === undefined) return call(forward);
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    return errorResult({ code: "invalid_output_path", message: "output_path must be a non-empty path" });
  }
  const target = resolve(outputPath);
  const replace = overwrite === true;

  // Fail before the (possibly slow) recalculation rather than after it.
  if (!replace && (await exists(target))) {
    return errorResult({
      code: "output_exists",
      message: `${target} already exists. Pass overwrite: true to replace it, or choose another output_path.`,
    });
  }
  if (!(await exists(dirname(target)))) {
    return errorResult({ code: "output_dir_missing", message: `the folder ${dirname(target)} does not exist` });
  }

  const result = await call(forward);
  if (result.isError) return result;
  const text = firstText(result);
  let payload: Record<string, unknown> & { file_base64?: unknown; summary?: { macro_enabled?: boolean } };
  try {
    payload = JSON.parse(text ?? "");
  } catch {
    return result;
  }
  if (typeof payload.file_base64 !== "string") return result;

  const bytes = Buffer.from(payload.file_base64, "base64");
  try {
    await writeFile(target, bytes, { flag: replace ? "w" : "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return errorResult({ code: "output_exists", message: `${target} already exists. Pass overwrite: true to replace it.` });
    }
    return errorResult(err);
  }

  const { file_base64: _omitted, ...rest } = payload;
  const note =
    payload.summary?.macro_enabled && !/\.xlsm$/i.test(target)
      ? "This workbook contains macros. Excel opens it as macro-enabled only with an .xlsm extension."
      : undefined;
  return jsonResult({ ...rest, saved_to: target, ...(note ? { note } : {}) });
}
