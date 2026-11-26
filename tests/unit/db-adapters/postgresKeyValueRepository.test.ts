import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresKeyValueRepository } from "../../../src/lib/db/async/keyValueRepository";
import type { Queryable, QueryResult } from "../../../src/lib/db/async/postgresTypes";

describe("PostgreSQL key-value repository", () => {
  test("uses parameterized statements and the caller-provided transaction", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const db: Queryable = {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        calls.push({ sql, values });
        return { rows: [], rowCount: 1 } as QueryResult<Row>;
      },
    };
    const tx: Queryable = {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        calls.push({ sql: "TX " + sql, values });
        return { rows: [], rowCount: 1 } as QueryResult<Row>;
      },
    };
    const repository = createPostgresKeyValueRepository(db);
    await repository.set({ namespace: "settings", key: "unsafe'key", value: '{"ok":true}' }, tx);
    assert.match(calls[0].sql, /^TX INSERT INTO key_value/);
    assert.deepEqual(calls[0].values, ["settings", "unsafe'key", '{"ok":true}']);
    assert.match(calls[0].sql, /ON CONFLICT \(namespace, key\)/);
  });

  test("returns null for missing keys and maps existing values", async () => {
    let rows: Array<Record<string, unknown>> = [];
    const db: Queryable = {
      async query<Row extends Record<string, unknown>>() {
        return { rows: rows as Row[], rowCount: rows.length };
      },
    };
    const repository = createPostgresKeyValueRepository(db);
    assert.equal(await repository.get("settings", "missing"), null);
    rows = [{ value: "stored" }];
    assert.equal(await repository.get("settings", "present"), "stored");
  });

  test("returns delete status and ordered namespace records", async () => {
    const db: Queryable = {
      async query<Row extends Record<string, unknown>>(sql: string) {
        if (sql.startsWith("DELETE")) return { rows: [], rowCount: 1 };
        return {
          rows: [
            { namespace: "settings", key: "a", value: "1" },
            { namespace: "settings", key: "b", value: "2" },
          ] as Row[],
          rowCount: 2,
        };
      },
    };
    const repository = createPostgresKeyValueRepository(db);
    assert.equal(await repository.delete("settings", "a"), true);
    assert.deepEqual(await repository.list("settings"), [
      { namespace: "settings", key: "a", value: "1" },
      { namespace: "settings", key: "b", value: "2" },
    ]);
  });
});
