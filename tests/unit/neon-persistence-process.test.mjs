import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-neon-process-test-"));
const SCRIPT = fileURLToPath(new URL("../../scripts/neon/persistence.mjs", import.meta.url));
const SQL_FIXTURE = "CREATE TABLE fixture (id INTEGER PRIMARY KEY);\nINSERT INTO fixture VALUES (1);\n";

const SQLITE_STUB = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);

if (args[0] === "--version") {
  process.stdout.write("sqlite3 test stub\n");
} else if (args[1] && args[1].startsWith(".backup ")) {
  const match = args[1].match(/^\.backup '(.+)'$/);
  if (!match) {
    process.stderr.write("invalid backup command\n");
    process.exitCode = 2;
  } else {
    fs.copyFileSync(args[0], match[1]);
  }
} else if (args[1] === ".dump") {
  const value = Buffer.from(process.env.FAKE_SQLITE_DUMP || "SELECT 1;\n");
  const failAfter = Number(process.env.FAKE_SQLITE_DUMP_FAIL_AFTER || 0);
  process.stdout.write(failAfter > 0 ? value.subarray(0, failAfter) : value);
  if (failAfter > 0) process.exitCode = 23;
} else if (args[1] === "PRAGMA integrity_check;") {
  process.stdout.write("ok\n");
} else if (args.length === 1) {
  const sqlCapture = fs.createWriteStream(process.env.FAKE_RESTORE_SQL_CAPTURE);
  process.stdin.pipe(sqlCapture);
  sqlCapture.on("finish", () => {
    fs.writeFileSync(args[0], Buffer.from("restored SQLite database"));
  });
} else {
  process.stderr.write("unsupported sqlite3 invocation: " + args.join(" ") + "\n");
  process.exitCode = 2;
}
`;

const PSQL_STUB = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);

if (args.includes("--version")) {
  fs.writeFileSync(process.env.FAKE_PSQL_COPY_RESULT, JSON.stringify({
    started: false,
    terminated: false,
    committed: false,
  }));
  process.stdout.write("psql test stub\n");
} else {
  const commands = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "-c") commands.push(args[i + 1]);
  }
  if (commands.some((command) => command.startsWith("COPY (SELECT payload FROM"))) {
    process.stdout.write(process.env.FAKE_PSQL_PAYLOAD || "");
  } else if (commands.some((command) => command.startsWith("\\copy "))) {
    fs.writeFileSync(process.env.FAKE_PSQL_COPY_RESULT, JSON.stringify({
      started: true,
      terminated: false,
      committed: false,
      commands,
    }));
    const capture = fs.createWriteStream(process.env.FAKE_PSQL_COPY_CAPTURE);
    let tail = Buffer.alloc(0);
    process.stdin.on("data", (chunk) => {
      tail = Buffer.concat([tail, chunk]).subarray(-4);
    });
    process.stdin.pipe(capture);
    capture.on("finish", () => {
      const terminated = tail.equals(Buffer.from("\n\\.\n"));
      fs.writeFileSync(process.env.FAKE_PSQL_COPY_RESULT, JSON.stringify({
        terminated,
        committed: terminated && commands.includes("COMMIT"),
        commands,
      }));
      if (!terminated) process.exitCode = 17;
    });
  }
}
`;

function setupCase(name) {
  const root = path.join(ROOT, name);
  const bin = path.join(root, "bin");
  const data = path.join(root, "data");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  for (const [file, source] of [["sqlite3", SQLITE_STUB], ["psql", PSQL_STUB]]) {
    const fullPath = path.join(bin, file);
    fs.writeFileSync(fullPath, source, { mode: 0o700 });
    fs.chmodSync(fullPath, 0o700);
  }

  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    DATA_DIR: data,
    DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/omniroute_test",
    OMNIROUTE_NEON_PERSISTENCE: "1",
    OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES: String(1024 * 1024),
    FAKE_SQLITE_DUMP: SQL_FIXTURE,
    FAKE_RESTORE_SQL_CAPTURE: path.join(root, "restored.sql"),
    FAKE_PSQL_COPY_CAPTURE: path.join(root, "copy.payload"),
    FAKE_PSQL_COPY_RESULT: path.join(root, "copy-result.json"),
  };
  return { root, data, env };
}

function runHelper(env, command) {
  return spawnSync(process.execPath, [SCRIPT, command], {
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
}

function leftoverFiles(dataDir) {
  return fs.readdirSync(dataDir).filter((name) => name.startsWith(".neon-"));
}

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Neon snapshot streams a complete dump through gzip/Base64 and commits COPY", () => {
  const { data, env } = setupCase("snapshot-success");
  fs.writeFileSync(path.join(data, "storage.sqlite"), Buffer.from("sqlite fixture"));
  const result = runHelper(env, "snapshot");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const copyResult = JSON.parse(fs.readFileSync(env.FAKE_PSQL_COPY_RESULT, "utf8"));
  assert.equal(copyResult.terminated, true);
  assert.equal(copyResult.committed, true);
  assert.deepEqual(copyResult.commands.slice(0, 3), [
    "BEGIN",
    "\\copy omniroute_sqlite_snapshots(payload) FROM STDIN",
    "COMMIT",
  ]);

  const copyText = fs.readFileSync(env.FAKE_PSQL_COPY_CAPTURE, "utf8");
  const terminator = "\n\\.\n";
  assert.ok(copyText.endsWith(terminator));
  const encoded = copyText.slice(0, -terminator.length).replace(/\s+/g, "");
  assert.equal(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"), SQL_FIXTURE);
  assert.deepEqual(leftoverFiles(data), []);
});

test("a partial SQLite dump cannot publish a recovery snapshot and cleans its temporary backup", () => {
  const { data, env } = setupCase("snapshot-failure");
  fs.writeFileSync(path.join(data, "storage.sqlite"), Buffer.from("sqlite fixture"));
  env.FAKE_SQLITE_DUMP_FAIL_AFTER = "12";
  const result = runHelper(env, "snapshot");

  assert.notEqual(result.status, 0, "a failing sqlite3 dump must fail the snapshot command");
  const copyResult = JSON.parse(fs.readFileSync(env.FAKE_PSQL_COPY_RESULT, "utf8"));
  assert.equal(copyResult.terminated, false);
  assert.equal(copyResult.committed, false);
  assert.deepEqual(leftoverFiles(data), []);
});

test("cold restore streams Base64/gzip SQL into SQLite and atomically publishes the database", () => {
  const { data, env } = setupCase("restore-success");
  env.FAKE_PSQL_PAYLOAD = gzipSync(Buffer.from(SQL_FIXTURE)).toString("base64") + "\n";
  const result = runHelper(env, "restore");

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const database = path.join(data, "storage.sqlite");
  assert.equal(fs.readFileSync(database, "utf8"), "restored SQLite database");
  assert.equal(fs.readFileSync(env.FAKE_RESTORE_SQL_CAPTURE, "utf8"), SQL_FIXTURE);
  assert.equal(fs.statSync(database).mode & 0o777, 0o600);
  assert.deepEqual(leftoverFiles(data), []);
});
