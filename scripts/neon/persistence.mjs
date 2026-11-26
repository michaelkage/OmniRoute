#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const TABLE = "omniroute_sqlite_snapshots";
const HARD_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_BUFFER = HARD_MAX_SNAPSHOT_BYTES * 2;

export function parseRetention(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 12;
  return Math.min(100, Math.max(1, parsed));
}

export function parseInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 300000;
  return Math.max(60000, Math.floor(parsed));
}

export function parseMaxSnapshotBytes(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_MAX_SNAPSHOT_BYTES;
  return Math.min(HARD_MAX_SNAPSHOT_BYTES, Math.max(1024 * 1024, parsed));
}

export function assertSnapshotSize(filePath, maxBytes = parseMaxSnapshotBytes(process.env.OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES)) {
  const size = fs.statSync(filePath).size;
  if (size > maxBytes) {
    throw new Error(
      "SQLite database is " + size + " bytes, exceeding the configured Neon snapshot limit of " +
      maxBytes + " bytes. Snapshot was refused to protect the host memory budget; increase " +
      "OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES only after measuring peak RSS, or use durable storage."
    );
  }
  return size;
}

export function parsePostgresConnection(connectionString) {
  if (!connectionString || !connectionString.trim()) throw new Error("DATABASE_URL is required.");
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error("DATABASE_URL is not a valid PostgreSQL connection URL."); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://.");
  }
  if (!url.hostname || !url.username || !url.pathname || url.pathname === "/") {
    throw new Error("DATABASE_URL must include a host, username and database name.");
  }
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get("sslmode") || "require",
    ...(url.searchParams.get("channel_binding") ? { PGCHANNELBINDING: url.searchParams.get("channel_binding") } : {}),
    PGCONNECT_TIMEOUT: "15",
    PGAPPNAME: "omniroute-neon-persistence"
  };
}

function resolveDefaultDataDir() {
  const home = os.homedir();
  const legacy = path.join(home, ".omniroute");
  let platformDir = null;
  if (process.platform === "win32") {
    platformDir = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "omniroute");
  } else if (process.env.XDG_CONFIG_HOME?.trim()) {
    platformDir = path.join(path.resolve(process.env.XDG_CONFIG_HOME), "omniroute");
  }
  if (!platformDir) return legacy;
  const legacyExists = fs.existsSync(legacy) && fs.statSync(legacy).isDirectory();
  const legacyHasDb = fs.existsSync(path.join(legacy, "storage.sqlite"));
  const platformHasDb = fs.existsSync(path.join(platformDir, "storage.sqlite"));
  if (legacyExists && !(platformHasDb && !legacyHasDb)) return legacy;
  return platformDir;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR?.trim() || resolveDefaultDataDir());
const SQLITE_FILE = path.join(DATA_DIR, "storage.sqlite");
const DATABASE_URL = process.env.DATABASE_URL?.trim();
const RETENTION = parseRetention(process.env.OMNIROUTE_NEON_SNAPSHOT_RETENTION);
const MAX_SNAPSHOT_BYTES = parseMaxSnapshotBytes(process.env.OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES);

function command(name, args, options = {}) {
  const result = spawnSync(name, args, {
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    input: options.input,
    maxBuffer: MAX_BUFFER,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    throw new Error(name + " failed (" + result.status + "): " + (stderr || "unknown error"));
  }
  return String(result.stdout || "");
}

function assertEnabled() {
  if (process.env.OMNIROUTE_NEON_PERSISTENCE !== "1") {
    throw new Error("Set OMNIROUTE_NEON_PERSISTENCE=1 to enable Neon persistence.");
  }
  if (!DATABASE_URL) throw new Error("DATABASE_URL is required when Neon persistence is enabled.");
  parsePostgresConnection(DATABASE_URL);
}

function assertTooling() {
  command("psql", ["--version"]);
  command("sqlite3", ["--version"]);
}

function postgresEnv() {
  return { ...process.env, ...parsePostgresConnection(DATABASE_URL) };
}

function psql(args, input) {
  return command("psql", ["-v", "ON_ERROR_STOP=1", "-X", "-w", ...args],
    input === undefined ? { env: postgresEnv() } : { input, env: postgresEnv() });
}

function ensureTable() {
  psql(["-c", "CREATE TABLE IF NOT EXISTS " + TABLE + " (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS " + TABLE + "_created_at_idx ON " + TABLE + "(created_at DESC, id DESC);"]);
}

function latestPayload() {
  return psql(["-At", "-c", "SELECT payload FROM " + TABLE + " ORDER BY created_at DESC, id DESC LIMIT 1;"]).trim();
}

function cleanupSnapshots() {
  psql(["-c", "DELETE FROM " + TABLE + " WHERE id NOT IN (SELECT id FROM " + TABLE + " ORDER BY created_at DESC, id DESC LIMIT " + RETENTION + ");"]);
}

function createSqliteBackup() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(SQLITE_FILE)) throw new Error("SQLite database does not exist: " + SQLITE_FILE);
  const temp = path.join(DATA_DIR, ".neon-snapshot-" + process.pid + "-" + Date.now() + ".sqlite");
  try {
    command("sqlite3", [SQLITE_FILE, ".backup '" + temp.replaceAll("'", "''") + "'"]);
    fs.chmodSync(temp, 0o600);
    assertSnapshotSize(temp, MAX_SNAPSHOT_BYTES);
    return temp;
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function captureTail(stream, limit = 64 * 1024) {
  let value = "";
  stream.on("data", (chunk) => {
    value = (value + chunk.toString("utf8")).slice(-limit);
  });
  return () => value.trim();
}

/** Base64 encoder that retains at most two bytes between chunks. */
export function createBase64Encoder() {
  let carry = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _encoding, callback) {
      const input = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const completeLength = input.length - (input.length % 3);
      if (completeLength > 0) this.push(input.subarray(0, completeLength).toString("base64"));
      carry = Buffer.from(input.subarray(completeLength));
      callback();
    },
    flush(callback) {
      if (carry.length) this.push(carry.toString("base64"));
      carry = Buffer.alloc(0);
      callback();
    },
  });
}

function waitForChild(child, label, getStderr) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(getStderr() || label + " exited with " + (signal || code)));
    });
  });
}

/**
 * Stream sqlite3's SQL dump through gzip + base64 directly into psql's COPY stdin.
 * Memory use is bounded by stream high-water marks rather than database size.
 */
async function uploadSnapshotDump(sqliteFile) {
  const dump = spawn("sqlite3", [sqliteFile, ".dump"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const postgres = spawn(
    "psql",
    ["-v", "ON_ERROR_STOP=1", "-X", "-w", "-c", "\\copy " + TABLE + "(payload) FROM STDIN"],
    { env: postgresEnv(), stdio: ["pipe", "pipe", "pipe"] }
  );

  const dumpError = captureTail(dump.stderr);
  const postgresError = captureTail(postgres.stderr);
  captureTail(postgres.stdout);
  const dumpDone = waitForChild(dump, "sqlite3 dump", dumpError);
  const postgresDone = waitForChild(postgres, "psql COPY", postgresError);
  let encodedBytes = 0;

  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      encodedBytes += chunk.length;
      callback(null, chunk);
    },
  });

  const destination = new Writable({
    write(chunk, _encoding, callback) {
      if (postgres.stdin.destroyed) {
        callback(new Error("PostgreSQL COPY input closed before the snapshot finished."));
        return;
      }
      if (postgres.stdin.write(chunk)) callback();
      else postgres.stdin.once("drain", callback);
    },
    final(callback) {
      postgres.stdin.end("\n\\.\n", callback);
    },
    destroy(error, callback) {
      if (error && !postgres.stdin.destroyed) postgres.stdin.destroy(error);
      callback(error);
    },
  });

  const timeout = setTimeout(() => {
    dump.kill("SIGTERM");
    postgres.kill("SIGTERM");
  }, 110_000);
  timeout.unref?.();

  try {
    await pipeline(dump.stdout, createGzip({ level: 6 }), createBase64Encoder(), meter, destination);
    await Promise.all([dumpDone, postgresDone]);
    if (encodedBytes === 0) throw new Error("SQLite dump was empty; refusing to upload an empty snapshot.");
    return encodedBytes;
  } catch (error) {
    dump.kill("SIGTERM");
    postgres.kill("SIGTERM");
    await Promise.allSettled([dumpDone, postgresDone]);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function snapshot() {
  assertEnabled();
  assertTooling();
  ensureTable();
  let temp;
  try {
    temp = createSqliteBackup();
    const encodedBytes = await uploadSnapshotDump(temp);
    cleanupSnapshots();
    console.log("[NEON] snapshot saved (" + Math.round(encodedBytes / 1024) + " KiB compressed payload; SQLite limit " + MAX_SNAPSHOT_BYTES + " bytes)");
  } finally {
    if (temp) fs.rmSync(temp, { force: true });
  }
}


function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function restore() {
  assertEnabled();
  assertTooling();
  if (fs.existsSync(SQLITE_FILE)) {
    console.log("[NEON] local SQLite database already exists; restore skipped.");
    return false;
  }
  for (const suffix of ["-wal", "-shm"]) {
    if (fs.existsSync(SQLITE_FILE + suffix)) {
      throw new Error("Found " + SQLITE_FILE + suffix + " without the main database. Inspect the SQLite sidecar before restoring.");
    }
  }
  ensureTable();
  const payload = latestPayload();
  if (!payload) {
    console.log("[NEON] no Neon snapshot exists; allowing first-time SQLite initialization.");
    return false;
  }
  if (Buffer.byteLength(payload, "utf8") > MAX_BUFFER) {
    throw new Error("Stored Neon snapshot exceeds the bounded restore buffer; refusing to allocate it.");
  }
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const stamp = process.pid + "-" + Date.now();
  const dumpFile = path.join(DATA_DIR, ".neon-restore-" + stamp + ".sql");
  const tempDb = path.join(DATA_DIR, ".neon-restore-" + stamp + ".sqlite");
  try {
    const dump = gunzipSync(Buffer.from(payload, "base64"), { maxOutputLength: MAX_BUFFER });
    fs.writeFileSync(dumpFile, dump, { mode: 0o600, flag: "wx" });
    command("sqlite3", [tempDb], { input: dump });
    const integrity = command("sqlite3", [tempDb, "PRAGMA integrity_check;"]).trim();
    if (integrity !== "ok") throw new Error("Restored SQLite integrity check failed: " + integrity.slice(0, 500));
    assertSnapshotSize(tempDb, MAX_SNAPSHOT_BYTES);
    fs.chmodSync(tempDb, 0o600);
    fsyncFile(tempDb);
    try {
      fs.linkSync(tempDb, SQLITE_FILE);
    } catch (error) {
      if (error?.code === "EEXIST") {
        console.log("[NEON] another process created the local database; restore skipped.");
        return false;
      }
      throw error;
    }
    fsyncFile(SQLITE_FILE);
    console.log("[NEON] restored and integrity-checked SQLite database from Neon.");
    return true;
  } finally {
    fs.rmSync(dumpFile, { force: true });
    fs.rmSync(tempDb, { force: true });
  }
}

export async function runCli(commandName = process.argv[2] || "snapshot") {
  assertEnabled();
  if (commandName === "ensure") {
    assertTooling();
    ensureTable();
    console.log("[NEON] snapshot table is ready.");
  } else if (commandName === "snapshot") await snapshot();
  else if (commandName === "restore") restore();
  else throw new Error("Unknown command: " + commandName);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await runCli(); }
  catch (error) {
    console.error("[NEON] " + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
