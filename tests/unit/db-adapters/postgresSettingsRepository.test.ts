import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createPostgresSettingsRepository,
  SettingsRevisionConflictError,
  SETTINGS_REVISION_KEY,
} from "../../../src/lib/db/async/settingsRepository";
import type { Queryable, QueryResult } from "../../../src/lib/db/async/postgresTypes";

type Call = { sql: string; values?: readonly unknown[] };
function fakeDb(initialRevision = 4) {
  const calls: Call[] = [];
  let revision = initialRevision;
  const tx: Queryable = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql.startsWith("SELECT value FROM key_value") && sql.includes("FOR UPDATE")) {
        return { rows: [{ value: JSON.stringify(revision) }] as Row[], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE key_value") && sql.includes("SET value = $2")) {
        revision = Number(JSON.parse(String(values?.[1])));
      }
      return { rows: [], rowCount: 1 } as QueryResult<Row>;
    },
  };
  const db = {
    calls,
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      return {
        rows: [
          { namespace: "databaseSettings", key: "known", value: "fallback" },
          { namespace: "settings", key: "custom", value: "value" },
          { namespace: "settings", key: SETTINGS_REVISION_KEY, value: JSON.stringify(revision) },
        ] as Row[],
        rowCount: 3,
      };
    },
    async transaction<T>(callback: (queryable: Queryable) => Promise<T>) {
      return callback(tx);
    },
  };
  return db;
}

describe("PostgreSQL settings repository", () => {
  test("reads settings rows and the monotonic revision", async () => {
    const db = fakeDb(7);
    const snapshot = await createPostgresSettingsRepository(db).read();
    assert.equal(snapshot.revision, 7);
    assert.equal(snapshot.settings[0].namespace, "databaseSettings");
    assert.equal(snapshot.settings[1].key, "custom");
  });

  test("serializes writers with a row lock and increments revision atomically", async () => {
    const db = fakeDb(4);
    const repository = createPostgresSettingsRepository(db);
    const next = await repository.update(4, [
      { key: "featureEnabled", value: "true" },
      { namespace: "databaseSettings", key: "known", value: "false" },
    ]);
    assert.equal(next, 5);
    assert.ok(db.calls.some((call) => call.sql.includes("FOR UPDATE")));
    assert.ok(db.calls.some((call) => call.sql.includes("ON CONFLICT (namespace, key)")));
    assert.ok(db.calls.every((call) => !call.sql.includes("featureEnabled")));
  });

  test("rejects stale revisions before applying updates", async () => {
    const db = fakeDb(9);
    const repository = createPostgresSettingsRepository(db);
    await assert.rejects(
      repository.update(8, [{ key: "shouldNotWrite", value: "x" }]),
      (error: unknown) =>
        error instanceof SettingsRevisionConflictError && error.currentRevision === 9
    );
    assert.equal(db.calls.some((call) => call.values?.includes("shouldNotWrite")), false);
  });

  test("rejects attempts to overwrite the internal revision key", async () => {
    const repository = createPostgresSettingsRepository(fakeDb());
    await assert.rejects(
      repository.update(4, [{ key: SETTINGS_REVISION_KEY, value: "99" }]),
      /cannot write the revision key/
    );
  });
});
