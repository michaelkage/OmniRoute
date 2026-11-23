#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_SUPPORTED_SNAPSHOT_BYTES = 64 * 1024 * 1024;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function validateRenderFreeEnv(env = process.env) {
  const errors = [];
  const warnings = [];
  const memoryMb = positiveInteger(env.OMNIROUTE_MEMORY_MB, 256);
  const helperMemoryMb = positiveInteger(env.OMNIROUTE_NEON_HELPER_MEMORY_MB, 64);
  const snapshotBytes = positiveInteger(env.OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES, 16 * 1024 * 1024);
  const intervalMs = positiveInteger(env.OMNIROUTE_NEON_SNAPSHOT_INTERVAL_MS, 600000);
  const retention = positiveInteger(env.OMNIROUTE_NEON_SNAPSHOT_RETENTION, 3);
  const concurrency = positiveInteger(env.OMNI_MAX_CONCURRENT_CONNECTIONS, 8);

  if (env.NODE_ENV !== "production") errors.push("NODE_ENV must be production.");
  if (env.HOSTNAME !== "0.0.0.0") errors.push("HOSTNAME must be 0.0.0.0 for Render web services.");
  if (!env.DATA_DIR || !path.isAbsolute(env.DATA_DIR) || !env.DATA_DIR.startsWith("/tmp/")) {
    errors.push("DATA_DIR must be an absolute /tmp/... path on Render Free; the filesystem is ephemeral.");
  }
  if (env.REQUIRE_API_KEY !== "true") errors.push("REQUIRE_API_KEY must be true on a public deployment.");
  if (env.OMNIROUTE_NEON_PERSISTENCE !== "1") errors.push("OMNIROUTE_NEON_PERSISTENCE must be 1 for snapshot recovery.");
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) errors.push("JWT_SECRET must be a generated secret of at least 32 characters.");
  if (!env.API_KEY_SECRET || env.API_KEY_SECRET.length < 32) errors.push("API_KEY_SECRET must be a generated secret of at least 32 characters.");
  if (!env.INITIAL_PASSWORD || env.INITIAL_PASSWORD === "CHANGEME") errors.push("INITIAL_PASSWORD must be a unique generated password.");

  let databaseUrl;
  try {
    databaseUrl = new URL(env.DATABASE_URL || "");
    if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
        !databaseUrl.hostname || !databaseUrl.username || databaseUrl.pathname.length < 2) {
      errors.push("DATABASE_URL must be a valid postgres:// or postgresql:// URL with host, user and database.");
    }
  } catch {
    errors.push("DATABASE_URL must be a valid postgres:// or postgresql:// URL.");
  }

  if (memoryMb < 192 || memoryMb > 320) {
    errors.push("OMNIROUTE_MEMORY_MB must be between 192 and 320 for the documented 512 MB profile.");
  }
  if (helperMemoryMb < 64 || helperMemoryMb > 192) {
    errors.push("OMNIROUTE_NEON_HELPER_MEMORY_MB must be between 64 and 192.");
  }
  if (snapshotBytes < 1024 * 1024 || snapshotBytes > MAX_SUPPORTED_SNAPSHOT_BYTES) {
    errors.push("OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES must be between 1 MiB and 64 MiB.");
  }
  if (intervalMs < 60000) errors.push("OMNIROUTE_NEON_SNAPSHOT_INTERVAL_MS must be at least 60000.");
  if (retention > 100) errors.push("OMNIROUTE_NEON_SNAPSHOT_RETENTION cannot exceed 100.");
  if (concurrency > 16) errors.push("OMNI_MAX_CONCURRENT_CONNECTIONS must not exceed 16 in this profile.");

  warnings.push("PostgreSQL is used for periodic SQLite recovery snapshots, not live SQL queries.");
  warnings.push("The local SQLite database is ephemeral; changes since the last successful snapshot can be lost.");
  warnings.push("The V8 heap ceiling is not an RSS limit. Validate peak process RSS under real proxy traffic.");
  warnings.push("This configuration is single-instance only; do not scale it horizontally.");

  return { ok: errors.length === 0, errors, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateRenderFreeEnv();
  for (const warning of result.warnings) console.warn("[Render Free] WARNING: " + warning);
  if (!result.ok) {
    for (const error of result.errors) console.error("[Render Free] ERROR: " + error);
    process.exitCode = 1;
  } else {
    console.log("[Render Free] Environment preflight passed.");
  }
}
