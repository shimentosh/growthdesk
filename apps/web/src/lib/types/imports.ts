/*
 * Contact imports — shapes of apps/api/src/crm/imports.service.ts. Dates
 * arrive as ISO strings.
 */
import type { IMPORT_FIELDS, ImportStatus } from "@growthdesk/shared";

/** A built-in destination for a CSV column. Custom fields are "custom.<key>"; "" skips the column. */
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** POST /imports/preview — `preview()` */
export type ImportPreview = {
  headers: string[];
  /** Up to the first 10 rows, keyed by header. */
  sample: Record<string, string>[];
  totalRows: number;
  /** Header → guessed field ("" when no guess). */
  suggested: Record<string, string>;
  fields: ImportField[];
};

/** POST /imports — `start()` */
export type ImportStartResult = { id: string; totalRows: number; status: ImportStatus };

/** GET /imports — `list()` (newest first, at most 100, not paged) */
export type ImportSummary = {
  id: string;
  /** csv | api | business_os */
  source: string;
  status: ImportStatus;
  fileName: string;
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: string;
  finishedAt: string | null;
};

/** One row that could not be imported. `row` is the line in the file (header = 1); 0 means the whole import failed. */
export type ImportRowError = { row: number; message: string };

/** What `start()` stores in `options` for a CSV import (other sources may store less). */
export type ImportOptions = {
  tags?: string[];
  onDuplicate?: "update" | "skip";
  leadSource?: string;
  defaultCountry?: string;
};

/** GET /imports/:id — `get()`: the whole row except the parsed rows. */
export type ImportDetail = ImportSummary & {
  workspaceId: string;
  mapping: Record<string, string>;
  options: ImportOptions;
  /** At most 500 are kept (MAX_ERRORS). */
  errors: ImportRowError[];
  idempotencyKey: string | null;
  createdById: string | null;
  startedAt: string | null;
  updatedAt: string;
};

/** How many row errors the service keeps (MAX_ERRORS), so the page can say when some were dropped. */
export const IMPORT_MAX_ERRORS = 500;
/** ImportPreviewInput / ImportStartInput: csv max length (characters). */
export const IMPORT_MAX_CSV_CHARS = 15_000_000;
/** imports.service.ts MAX_ROWS. */
export const IMPORT_MAX_ROWS = 50_000;
