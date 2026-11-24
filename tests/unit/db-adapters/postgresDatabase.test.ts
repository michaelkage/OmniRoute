import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDatabase } from "../../../src/lib/db/async/postgresDatabase";
import type { Pool, PoolClient, QueryResult } from "../../../src/lib/db/async/postgresTypes";

type Call = { sql: string; values?: readonly unknown[] };

function fakePool(handler: (sql: string) => Promise<QueryResult> | QueryResult = () => ({
  rows: [{ healthy: 1 }], rowCount: 1,
})) {
  const calls: Call[] = [];
  let released = 0;
  let ended = 0;
  let releaseError: Error | boolean | undefined;
  const client: PoolClient = {
    async query(sql, values) {
      calls.push({ sql, values });
      return await handler(sql);
    },
    release(error) {
      released += 1;
      releaseError = error;
    },
  };
  const pool: Pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      return await handler(sql);
    },
    async connect() {
      return client;
    },
    async end() {
      ended += 1;
    },
  };
  return {
    pool,
    calls,
    get released() { return released; },
    get ended() { return ended; },
    get releaseError() { return releaseError; },
  };
}

describe("createPostgresDatabase", () => {
  test("executes work and commits on one checked-out client", async () => {
    const fake = fakePool();
    const db = createPostgresDatabase(fake.pool);
    const result = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO example(value) VALUES ($1)", ["safe"]);
      return "committed";
    });
    assert.equal(result, "committed");
    assert.deepEqual(fake.calls.map((call) => call.sql), [
      "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE NOT DEFERRABLE",
      "INSERT INTO example(value) VALUES ($1)",
      "COMMIT",
    ]);
    assert.equal(fake.released, 1);
  });

  test("rolls back on callback failure and rethrows the original error", async () => {
    const fake = fakePool();
    const db = createPostgresDatabase(fake.pool);
    const failure = new Error("write failed");
    await assert.rejects(db.transaction(async () => { throw failure; }), failure);
    assert.equal(fake.calls.at(-1)?.sql, "ROLLBACK");
    assert.equal(fake.released, 1);
  });

  test("retries serialization failures only when requested", async () => {
    let writes = 0;
    const fake = fakePool((sql) => {
      if (sql.startsWith("INSERT")) {
        writes += 1;
        if (writes === 1) {
          const error = new Error("serialization failure") as Error & { code: string };
          error.code = "40001";
          throw error;
        }
      }
      return { rows: [], rowCount: 1 };
    });
    const db = createPostgresDatabase(fake.pool);
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO example(value) VALUES ($1)", ["retry"]);
    }, { retries: 1 });
    assert.equal(writes, 2);
    assert.equal(fake.released, 2);
  });

  test("rejects unsafe isolation and retry settings before acquiring a client", async () => {
    const fake = fakePool();
    const db = createPostgresDatabase(fake.pool);
    await assert.rejects(db.transaction(async () => {}, { isolation: "unsafe" as never }), /isolation/i);
    await assert.rejects(db.transaction(async () => {}, { retries: 4 }), /retries/i);
    assert.equal(fake.released, 0);
  });

  test("requires serializable read-only mode for deferrable transactions", async () => {
    const fake = fakePool();
    const db = createPostgresDatabase(fake.pool);
    await assert.rejects(
      db.transaction(async () => {}, { deferrable: true }),
      /DEFERRABLE/
    );
    assert.equal(fake.released, 0);
  });

  test("health check reports latency and close is idempotent", async () => {
    const fake = fakePool();
    const db = createPostgresDatabase(fake.pool);
    assert.equal((await db.healthCheck()).healthy, true);
    await db.close();
    await db.close();
    assert.equal(fake.ended, 1);
    await assert.rejects(db.query("SELECT 1"), /closed/);
  });
});
