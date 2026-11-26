import { NextResponse } from "next/server";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "path";
import fs from "fs";
import { getDbInstance, resetDbInstance, SQLITE_FILE } from "@/lib/db/core";
import { openDatabaseAsync } from "@/lib/db/adapters/driverFactory";
import type { SqliteAdapter } from "@/lib/db/adapters/types";
import {
  backupDbFileAwaited,
  getTableNamesFromAdapter,
  countImportedRows,
  summarizeImportCandidate,
  unlinkFileWithRetry,
} from "@/lib/db/backup";
import {
  CREDENTIAL_IMPORT_FORBIDDEN_MESSAGE,
  requireOperatorCredential,
} from "@/lib/api/operatorCredential";
import { getSettings } from "@/lib/db/settings";
import { setSystemPromptConfig } from "@omniroute/open-sse/services/systemPrompt.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { snapshotNeonPersistenceNow } from "@/lib/neonPersistence";

const DEFAULT_MAX_UPLOAD_MB = 100;
// Hard ceiling so a misconfigured/hostile value can't ask the route to buffer an
// unbounded file from being accepted.
const MAX_UPLOAD_MB_CEILING = 4096;

/**
 * Resolve the maximum accepted backup size (bytes) from the environment.
 *
 * Real databases bloat well past the historical 100 MB cap (#4719 — a 156 MB file that
 * VACUUMs down to 5 MB still can't be re-imported), so the limit is now operator-tunable
 * via `OMNIROUTE_DB_IMPORT_MAX_MB`. Invalid / out-of-range values fall back to the 100 MB
 * default and are clamped to a 4 GB ceiling.
 */
export function resolveMaxUploadSizeBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OMNIROUTE_DB_IMPORT_MAX_MB;
  const parsed = raw === undefined ? NaN : Number(raw);
  const mb =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.min(Math.floor(parsed), MAX_UPLOAD_MB_CEILING)
      : DEFAULT_MAX_UPLOAD_MB;
  return mb * 1024 * 1024;
}

// Required tables that must exist in a valid OmniRoute database
const REQUIRED_TABLES = ["provider_connections", "provider_nodes", "combos", "api_keys"];

const DRY_RUN_TRUE = /^(1|true|yes)$/i;

/** `dryRun` is read from the query string or, for multipart uploads, a form field. */
export function isDryRunValue(value: unknown): boolean {
  return typeof value === "string" && DRY_RUN_TRUE.test(value.trim());
}

function badRequest(error: string): Response {
  return NextResponse.json({ error }, { status: 400 });
}

type Upload = { tmpDir: string; tmpPath: string; fileName: string; dryRun: boolean; fileSize: number };

class UploadTooLargeError extends Error {
  constructor() {
    super("Database upload exceeds the configured size limit.");
    this.name = "UploadTooLargeError";
  }
}

/** Stream the raw SQLite request body directly to a private file beside the live DB. */
export async function stageUpload(request: Request): Promise<Upload | Response> {
  const url = new URL(request.url);
  const queryDryRun = isDryRunValue(url.searchParams.get("dryRun"));
  const contentType = (request.headers.get("content-type") || "").toLowerCase();

  if (!contentType.startsWith("application/octet-stream")) {
    return NextResponse.json(
      { error: "Upload the .sqlite file as application/octet-stream; multipart uploads are not supported." },
      { status: 415 }
    );
  }
  if (!request.body) return badRequest("No file content provided.");
  if (!SQLITE_FILE) return NextResponse.json({ error: "SQLite storage is unavailable." }, { status: 503 });

  const fileName = path.basename(url.searchParams.get("filename") || "import.sqlite");
  const tmpDir = fs.mkdtempSync(path.join(path.dirname(SQLITE_FILE), ".omniroute-import-"));
  const tmpPath = path.join(tmpDir, "import.sqlite");
  const maxBytes = resolveMaxUploadSizeBytes();
  let fileSize = 0;

  try {
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        fileSize += chunk.length;
        if (fileSize > maxBytes) {
          callback(new UploadTooLargeError());
          return;
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream<Uint8Array>),
      limiter,
      fs.createWriteStream(tmpPath, { flags: "wx", mode: 0o600 })
    );
  } catch (error) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (error instanceof UploadTooLargeError) return tooLargeResponse();
    throw error;
  }

  if (fileSize === 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return badRequest("No file content provided.");
  }

  return { tmpDir, tmpPath, fileName, dryRun: queryDryRun, fileSize };
}

function tooLargeResponse(): Response {
  const maxUploadSize = resolveMaxUploadSizeBytes();
  return NextResponse.json(
    {
      error:
        `File too large. Maximum allowed size is ${maxUploadSize / (1024 * 1024)} MB. ` +
        `Set OMNIROUTE_DB_IMPORT_MAX_MB to raise it, or VACUUM the database before exporting.`,
    },
    { status: 413 }
  );
}

function validateUploadShape(fileName: string, fileSize: number): Response | null {
  if (!fileName.endsWith(".sqlite")) {
    return badRequest("Invalid file type. Only .sqlite files are accepted.");
  }
  const maxUploadSize = resolveMaxUploadSizeBytes();
  if (fileSize > maxUploadSize) {
    return tooLargeResponse();
  }
  if (fileSize < 4096) return badRequest("File too small to be a valid SQLite database.");
  return null;
}

type CandidateSummary = ReturnType<typeof summarizeImportCandidate>;

/**
 * Open the uploaded file read-only and validate it: SQLite integrity and the required
 * OmniRoute tables. Returns what a real import would load, or the 400 to send.
 *
 * Uses the resilient driver factory (better-sqlite3 → node:sqlite → sql.js) rather than a
 * direct `better-sqlite3` import: in the packaged Electron app that native module is absent
 * from the standalone server's node_modules (#3025).
 */
async function inspectCandidate(tmpPath: string): Promise<CandidateSummary | Response> {
  let testDb: SqliteAdapter | null = null;
  try {
    testDb = await openDatabaseAsync(tmpPath, { readonly: true });
    const result = testDb.pragma("integrity_check") as Array<{ integrity_check?: string }>;
    if (result[0]?.integrity_check !== "ok") {
      return badRequest("Database integrity check failed. The file may be corrupted.");
    }

    const tables = getTableNamesFromAdapter(testDb);
    const missingTables = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missingTables.length > 0) {
      return badRequest(`Invalid OmniRoute database. Missing tables: ${missingTables.join(", ")}`);
    }
    return summarizeImportCandidate(testDb, tables);
  } catch (e) {
    return badRequest(`Invalid database file: ${sanitizeErrorMessage(e)}`);
  } finally {
    if (testDb) testDb.close();
  }
}

/** Swap the validated upload in for the live database and report what is now loaded. */
async function replaceLiveDatabase(tmpPath: string, fileName: string): Promise<Response> {
  // Take the pre-import snapshot and wait for it to finish. It is mandatory (routine
  // backup switches and the hourly throttle do not apply), and a failure aborts the
  // import before any live data is touched.
  await backupDbFileAwaited("pre-import", { mandatory: true });

  // Close and reset current DB connection
  resetDbInstance();

  // Remove WAL sidecars after closing SQLite. The main database is replaced atomically below.
  const sqliteFilesToReplace = [
    `${SQLITE_FILE}-wal`,
    `${SQLITE_FILE}-shm`,
    `${SQLITE_FILE}-journal`,
  ];
  // Delete with EBUSY/EPERM retry: after resetDbInstance() the OS may still
  // hold the SQLite file handle for a moment (Windows mmap / antivirus), so a
  // plain unlink races to EBUSY (#5406). Mirror the restore path's helper.
  for (const filePath of sqliteFilesToReplace) {
    if (!filePath) continue;
    await unlinkFileWithRetry(filePath);
  }

  // Atomic same-filesystem replacement: staged file is beside SQLITE_FILE.
  fs.renameSync(tmpPath, SQLITE_FILE!);

  // Reopen and verify
  getDbInstance();
  const { connCount, nodeCount, comboCount, keyCount } = countImportedRows();

  console.log(
    `[DB] Imported database from upload: ${connCount} connections, ${nodeCount} nodes, ${comboCount} combos, ${keyCount} API keys`
  );

  // The DB was replaced wholesale — re-hydrate the in-memory Global System Prompt so it
  // reflects the imported settings without requiring a restart (#2470).
  try {
    const importedSettings = await getSettings();
    if (importedSettings.systemPrompt) {
      setSystemPromptConfig(importedSettings.systemPrompt);
    }
  } catch {
    // non-fatal: import succeeded; system prompt will hydrate on next restart
  }

  let neonSnapshot: "saved" | "disabled" | "failed" = "disabled";
  try {
    neonSnapshot = (await snapshotNeonPersistenceNow()) ? "saved" : "disabled";
  } catch (error) {
    neonSnapshot = "failed";
    console.error("[NEON] immediate post-import snapshot failed:", error instanceof Error ? error.message : String(error));
  }

  return NextResponse.json({
    imported: true,
    neonSnapshot,
    filename: fileName,
    connectionCount: connCount,
    nodeCount,
    comboCount,
    apiKeyCount: keyCount,
  });
}

/**
 * POST /api/db-backups/import — Upload a .sqlite file to replace the current database.
 *
 * Accepts multipart/form-data with a single "file" field containing the .sqlite backup,
 * or the raw file bytes (`?filename=` names it). Validates integrity, schema, and required
 * tables before replacing the active database.
 *
 * `dryRun=true` (query string, or a multipart `dryRun` field) runs the same validation and
 * returns what WOULD be imported, without the pre-import backup or touching the live
 * database.
 *
 * 🔒 Operator-only: dashboard session, the machine-bound local CLI credential (so
 *    `omniroute sync import` on the server host needs no API key), or login disabled. API
 *    keys of any scope and `oma_` access tokens get 403 — same boundary as the exports: a
 *    machine credential must not be able to replace the database. The dry run goes through
 *    the same guard.
 */
export async function POST(request: Request) {
  const operatorVerdict = await requireOperatorCredential(request, {
    forbiddenMessage: CREDENTIAL_IMPORT_FORBIDDEN_MESSAGE,
  });
  if (operatorVerdict.ok === false) return operatorVerdict.response;

  let upload: Upload | Response | null = null;
  try {
    upload = await stageUpload(request);
    if (upload instanceof Response) return upload;
    const { tmpPath, fileName, dryRun, fileSize } = upload;

    const shapeError = validateUploadShape(fileName, fileSize);
    if (shapeError) return shapeError;

    const summary = await inspectCandidate(tmpPath);
    if (summary instanceof Response) return summary;

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        valid: true,
        imported: false,
        filename: fileName,
        sizeBytes: fileSize,
        connectionCount: summary.connCount,
        nodeCount: summary.nodeCount,
        comboCount: summary.comboCount,
        apiKeyCount: summary.keyCount,
        schemaVersion: summary.schemaVersion,
      });
    }

    return await replaceLiveDatabase(tmpPath, fileName);
  } catch (error) {
    console.error("[API] Error importing database:", error);
    return NextResponse.json({ error: sanitizeErrorMessage(error) }, { status: 500 });
  } finally {
    if (upload && !(upload instanceof Response)) {
      fs.rmSync(upload.tmpDir, { recursive: true, force: true });
    }
  }
}
