import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runPostgresMigrations } from "../../../src/lib/db/async/postgresMigrationRunner";
import type { Pool, PoolClient, QueryResult } from "../../../src/lib/db/async/postgresTypes";

function createFakePool() {
  const calls: string[] = [];
  const ledger = new Map<string, { name: string; checksum: string }>();
  const client: PoolClient = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      calls.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("SELECT name, checksum")) {
        const row = ledger.get(String(values?.[0]));
        return { rows: row ? [row] as Row[] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO _omniroute_pg_migrations")) {
        ledger.set(String(values?.[0]), { name: String(values?.[1]), checksum: String(values?.[2]) });
      }
      return { rows: [], rowCount: 1 } as QueryResult<Row>;
    },
    release() {},
  };
  const pool: Pool = {
    async query<Row extends Record<string, unknown>>() {
      return { rows: [], rowCount: 0 } as QueryResult<Row>;
    },
    async connect() { return client; },
    async end() {},
  };
  return { pool, calls, ledger };
}

describe("PostgreSQL migration runner", () => {
  test("serializes migrations under advisory lock and commits ledger entries", async () => {
    const fake = createFakePool();
    const result = await runPostgresMigrations(fake.pool, [
      { id: "002", name: "second", sql: "SELECT 2" },
      { id: "001", name: "first", sql: "SELECT 1" },
    ]);
    assert.deepEqual(result.map((migration) => migration.id), ["001", "002"]);
    assert.ok(fake.calls[0].startsWith("SELECT pg_advisory_lock"));
    assert.ok(fake.calls.includes("COMMIT"));
    assert.ok(fake.calls.at(-1)?.startsWith("SELECT pg_advisory_unlock"));
  });

  test("rejects duplicate ids before checking out a client", async () => {
    const fake = createFakePool();
    await assert.rejects(
      runPostgresMigrations(fake.pool, [
        { id: "001", name: "one", sql: "SELECT 1" },
        { id: "001", name: "two", sql: "SELECT 2" },
      ]),
      /Duplicate/
    );
    assert.equal(fake.calls.length, 0);
  });

  test("fails closed when an applied migration checksum changes", async () => {
    const fake = createFakePool();
    await runPostgresMigrations(fake.pool, [{ id: "001", name: "first", sql: "SELECT 1" }]);
    await assert.rejects(
      runPostgresMigrations(fake.pool, [{ id: "001", name: "first", sql: "SELECT 9" }]),
      /modified after application/
    );
  });
});
