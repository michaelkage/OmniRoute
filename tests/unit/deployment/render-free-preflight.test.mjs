import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateRenderFreeEnv } from "../../../scripts/check/render-free-preflight.mjs";
import { parseMaxSnapshotBytes, parseRetention, parseInterval, assertSnapshotSize } from "../../../scripts/neon/persistence.mjs";

function validEnv() {
  return {
    NODE_ENV: "production",
    HOSTNAME: "0.0.0.0",
    DATA_DIR: "/tmp/omniroute-data",
    REQUIRE_API_KEY: "true",
    OMNIROUTE_NEON_PERSISTENCE: "1",
    JWT_SECRET: "x".repeat(48),
    API_KEY_SECRET: "y".repeat(64),
    INITIAL_PASSWORD: "unique-initial-password",
    DATABASE_URL: "postgresql://user:password@db.example.test/app?sslmode=require",
    OMNIROUTE_MEMORY_MB: "256",
    OMNIROUTE_NEON_HELPER_MEMORY_MB: "64",
    OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES: "16777216",
    OMNIROUTE_NEON_SNAPSHOT_INTERVAL_MS: "600000",
    OMNIROUTE_NEON_SNAPSHOT_RETENTION: "3",
    OMNI_MAX_CONCURRENT_CONNECTIONS: "8",
  };
}

test("Render Free preflight accepts the documented deployment profile", () => {
  const result = validateRenderFreeEnv(validEnv());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.length >= 3);
});

test("Render Free preflight rejects insecure and over-budget settings", () => {
  const env = validEnv();
  env.REQUIRE_API_KEY = "false";
  env.OMNIROUTE_MEMORY_MB = "1024";
  env.OMNIROUTE_NEON_MAX_SNAPSHOT_BYTES = String(128 * 1024 * 1024);
  env.DATA_DIR = "/app/data";
  const result = validateRenderFreeEnv(env);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("REQUIRE_API_KEY")));
  assert.ok(result.errors.some((error) => error.includes("OMNIROUTE_MEMORY_MB")));
  assert.ok(result.errors.some((error) => error.includes("snapshot")));
  assert.ok(result.errors.some((error) => error.includes("DATA_DIR")));
});

test("snapshot policy parsers clamp unsafe values", () => {
  assert.equal(parseMaxSnapshotBytes("999999999"), 64 * 1024 * 1024);
  assert.equal(parseMaxSnapshotBytes("invalid"), 16 * 1024 * 1024);
  assert.equal(parseRetention("1000"), 100);
  assert.equal(parseInterval("1"), 60000);
});

test("snapshot size guard rejects oversized SQLite databases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-snapshot-test-"));
  const file = path.join(dir, "storage.sqlite");
  try {
    fs.writeFileSync(file, Buffer.alloc(1024));
    assert.throws(() => assertSnapshotSize(file, 512), /exceeding the configured Neon snapshot limit/);
    assert.equal(assertSnapshotSize(file, 2048), 1024);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
