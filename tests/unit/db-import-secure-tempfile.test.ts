import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-db-import-stream-"));
const TEST_DATA_DIR = path.join(TEST_ROOT, "data");
fs.mkdirSync(TEST_DATA_DIR);
const ORIGINAL_ENV = {
  DATA_DIR: process.env.DATA_DIR,
  OMNIROUTE_DB_IMPORT_MAX_MB: process.env.OMNIROUTE_DB_IMPORT_MAX_MB,
};
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_DB_IMPORT_MAX_MB = "32";

const { stageUpload } = await import("../../src/app/api/db-backups/import/route.ts");

test.after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeRequest(body: ReadableStream<Uint8Array>) {
  return new Request("http://localhost:20128/api/db-backups/import?filename=fixture.sqlite", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  } as RequestInit);
}

function stagedDirectories() {
  return fs.readdirSync(TEST_DATA_DIR).filter((name) => name.startsWith(".omniroute-import-"));
}

function byteStream(totalBytes: number, chunkSize = 64 * 1024) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });
}

test("stages upload incrementally in a private directory beside the live database", async () => {
  const upload = await stageUpload(makeRequest(byteStream(512 * 1024)));
  assert.ok(!(upload instanceof Response));
  assert.equal(upload.fileSize, 512 * 1024);
  assert.equal(path.dirname(upload.tmpDir), TEST_DATA_DIR);
  assert.equal(fs.statSync(upload.tmpDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(upload.tmpPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(upload.tmpPath).size, 512 * 1024);
  fs.rmSync(upload.tmpDir, { recursive: true, force: true });
  assert.deepEqual(stagedDirectories(), []);
});

test("removes partial staging files when the request stream is interrupted", async () => {
  const interrupted = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(128 * 1024));
      controller.error(new Error("client disconnected"));
    },
  });

  await assert.rejects(() => stageUpload(makeRequest(interrupted)), /client disconnected/);
  assert.deepEqual(stagedDirectories(), []);
});

test("rejects oversized chunked uploads before consuming the complete request", async () => {
  let sent = 0;
  const total = 8 * 1024 * 1024;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(64 * 1024, total - sent);
      controller.enqueue(new Uint8Array(size));
      sent += size;
    },
  });

  process.env.OMNIROUTE_DB_IMPORT_MAX_MB = "1";
  const response = await stageUpload(makeRequest(stream));
  process.env.OMNIROUTE_DB_IMPORT_MAX_MB = "32";
  assert.ok(response instanceof Response);
  assert.equal(response.status, 413);
  assert.ok(sent < total, "the route consumed the complete oversized body");
  assert.deepEqual(stagedDirectories(), []);
});

test("accepts a multi-megabyte stream without constructing a whole-upload buffer", async () => {
  const total = 16 * 1024 * 1024;
  const upload = await stageUpload(makeRequest(byteStream(total)));
  assert.ok(!(upload instanceof Response));
  assert.equal(upload.fileSize, total);
  assert.equal(fs.statSync(upload.tmpPath).size, total);
  fs.rmSync(upload.tmpDir, { recursive: true, force: true });
  assert.deepEqual(stagedDirectories(), []);
});
