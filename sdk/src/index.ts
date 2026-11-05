// Public entry point. Re-exports only: each concern lives in its own module.
export {
  Basis,
  type BasisOptions,
  type CallOptions,
  type DiffWorkbooksOptions,
  type FileInput,
  type ParseMode,
  type ParseOptions,
  type RecordStreamOptions,
  type RetryOptions,
  type RecalcOptions,
  type SaveToLibraryOptions,
  type SubmitJobOptions,
} from "./client.ts";
export {
  BasisError,
  CLIENT_ERROR_CODES,
  SERVER_ERROR_CODES,
  type BasisErrorCode,
  type ClientErrorCode,
  type QuotaDetail,
  type ServerErrorCode,
} from "./errors.ts";
export { parseNdjson, readNdjson } from "./ndjson.ts";
export { verifyWebhookSignature, type VerifyWebhookInput, type WebhookPayload } from "./webhooks.ts";
export {
  diffRecords,
  type DiffCell,
  type DiffCellView,
  type DiffChangeKind,
  type DiffChanged,
  type DiffFormatChanged,
  type DiffOptions,
  type WorkbookDiff,
} from "./diff.ts";
export type {
  ExportedWorkbook,
  ExportSummary,
  ExportWarning,
  FormulaErrorCell,
  UncomputedCell,
  Job,
  JobError,
  JobLifecycleStatus,
  JobStatus,
  LibrarySaveResult,
  SheetInfo,
  StreamAuditFinding,
  StreamCellKind,
  StreamComment,
  StreamDataTable,
  StreamDefinedName,
  StreamEdgeKind,
  StreamNumberValue,
  StreamPlugCounts,
  StreamRecord,
} from "./types.ts";
