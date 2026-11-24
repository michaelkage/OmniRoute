import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createSqliteSettingsStorage,
  createPostgresSettingsStorage,
  SettingsStorage,
} from "../../../src/lib/db/async/settingsStorage";
import type { SqliteAdapter, PreparedStatement } from "../../../src/lib/db/adapters/types";
import type { AsyncDatabase, Queryable, QueryResult } from "../../../src/lib/db/async/postgresTypes";

function sqliteFixture() {
  const rows = new Map<string, string>();
  const makeKey = (namespace: string, key: string) => namespace + "\0" + key;
  const db = {
    driver: "sql.js",
    open: true,
    name: ":memory:",
    prepare(sql: string) {
      return {
        get(...params: unknown[]) {
          if (sql.includes("SELECT value FROM key_value")) {
            const value = rows.get(makeKey("settings", String(params[0])));
            return value === undefined ? undefined : { value };
          }
          return undefined;
        },
        all() {
          return [...rows.entries()].map(([key, value]) => {
            const [namespace, settingKey] = key.split("\0");
            return { namespace, key: settingKey, value };
          }).filter((row) => row.namespace === "settings" || row.namespace === "databaseSettings");
        },
        run(...params: unknown[]) {
          if (sql.startsWith("INSERT OR REPLACE")) {
            const [namespace, key, value] = params.map(String);
            rows.set(makeKey(namespace, key), value);
            return { changes: 1, lastInsertRowid: 1 };
          }
          return { changes: 0, lastInsertRowid: 0 };
        },
      } as PreparedStatement;
    },
    transaction<T>(fn: (...args: unknown[]) => T) {
      return () => fn();
    },
    exec() {},
    pragma() {},
    immediate(fn: () => void) { fn(); },
    async backup() {},
    checkpoint() {},
    close() {},
    raw: null,
  } as unknown as SqliteAdapter;
  return { db, rows, makeKey };
}

function postgresFixture(initialRevision = 2) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  const values = new Map<string, string>();
  values.set("settings\0_settingsRevision", JSON.stringify(initialRevision));
  const queryable: Queryable = {
    async query<Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      calls.push({ sql, values: params });
      if (sql.includes("SELECT namespace, key, value")) {
        const rows = [...values.entries()].map(([compound, value]) => {
          const [namespace, key] = compound.split("\0");
          return { namespace, key, value };
        });
        return { rows: rows as Row[], rowCount: rows.length };
      }
      if (sql.includes("SELECT value") && sql.includes("FOR UPDATE")) {
        const value = values.get("settings\0_settingsRevision") ?? "0";
        return { rows: [{ value }] as Row[], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO key_value")) {
        const [namespace, key, value] = params as string[];
        const compound = namespace + "\0" + key;
        if (sql.includes("DO UPDATE")) values.set(compound, value);
        else if (!values.has(compound)) values.set(compound, value);
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE key_value")) {
        values.set("settings\0_settingsRevision", String(params?.[1]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const db: AsyncDatabase = {
    query: queryable.query.bind(queryable),
    async transaction<T>(callback: (tx: Queryable) => Promise<T>) {
      return callback(queryable);
    },
    async healthCheck() { return { healthy: true, latencyMs: 0 }; },
    async close() {},
  };
  return { db, calls, values };
}

describe("settings storage adapters", () => {
  test("SQLite adapter preserves key_value reads, atomic writes and revision conflicts", async () => {
    const fixture = sqliteFixture();
    const storage = createSqliteSettingsStorage(fixture.db);
    await storage.update([{ key: "theme", value: '"dark"' }]);
    const snapshot = await storage.read();
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.rows.find((row) => row.key === "theme")?.value, '"dark"');
    await assert.rejects(
      storage.update([{ key: "theme", value: '"light"' }], 0),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "SETTINGS_REVISION_CONFLICT"
    );
    assert.equal(fixture.rows.get(fixture.makeKey("settings", "theme")), '"dark"');
  });

  test("PostgreSQL adapter uses transactional repository and keeps serialized values", async () => {
    const fixture = postgresFixture();
    const storage: SettingsStorage = createPostgresSettingsStorage(fixture.db);
    const nextRevision = await storage.update([
      { key: "theme", value: '"dark"' },
      { namespace: "databaseSettings", key: "legacy", value: "true" },
    ]);
    assert.equal(nextRevision, 3);
    const snapshot = await storage.read();
    assert.equal(snapshot.revision, 3);
    assert.equal(snapshot.rows.find((row) => row.key === "theme")?.value, '"dark"');
    assert.ok(fixture.calls.some((call) => call.sql.includes("FOR UPDATE")));
    assert.ok(fixture.calls.some((call) => call.sql.includes("ON CONFLICT (namespace, key)")));
  });

  test("PostgreSQL adapter preserves strict expected-revision semantics", async () => {
    const fixture = postgresFixture(5);
    const storage = createPostgresSettingsStorage(fixture.db);
    await assert.rejects(
      storage.update([{ key: "notWritten", value: "x" }], 4),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string }).code === "SETTINGS_REVISION_CONFLICT"
    );
    assert.equal(fixture.values.has("settings\0notWritten"), false);
  });
});
