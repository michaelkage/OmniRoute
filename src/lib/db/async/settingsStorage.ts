import { getDbInstance } from "../core";
import type { SqliteAdapter } from "../adapters/types";
import {
  createPostgresSettingsRepository,
  SettingsRevisionConflictError,
  type SettingsUpdate as PostgresSettingsUpdate,
} from "./settingsRepository";
import type { AsyncDatabase } from "./postgresTypes";

export interface SettingsStorageRow {
  namespace: "settings" | "databaseSettings";
  key: string;
  value: string;
}

export interface SettingsStorageUpdate {
  namespace?: "settings" | "databaseSettings";
  key: string;
  value: string;
}

export interface SettingsStorageSnapshot {
  rows: SettingsStorageRow[];
  revision: number;
}

export interface SettingsStorage {
  readonly backend: "sqlite" | "postgres";
  read(): Promise<SettingsStorageSnapshot>;
  update(
    updates: readonly SettingsStorageUpdate[],
    expectedRevision?: number
  ): Promise<number>;
}

export { SettingsRevisionConflictError, SETTINGS_REVISION_KEY } from "./settingsRepository";

/**
 * SQLite adapter. All SQL and transaction behavior intentionally match the
 * existing settings implementation, including optional optimistic revision
 * checks and one revision increment per batch.
 */
export function createSqliteSettingsStorage(db: SqliteAdapter): SettingsStorage {
  return {
    backend: "sqlite",
    async read() {
      const rows = db
        .prepare(
          "SELECT namespace, key, value FROM key_value WHERE namespace = 'settings'"
        )
        .all() as SettingsStorageRow[];
      const revisionRow = db
        .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
        .get("_settingsRevision") as { value?: string } | undefined;
      let revision = 0;
      if (revisionRow?.value) {
        try {
          const parsed: unknown = JSON.parse(revisionRow.value);
          if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0) {
            revision = parsed;
          }
        } catch {
          // Preserve the historical invalid-revision fallback to zero.
        }
      }
      return { rows, revision };
    },

    async update(updates, expectedRevision) {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)"
      );
      const transaction = db.transaction(() => {
        const row = db
          .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
          .get("_settingsRevision") as { value?: string } | undefined;
        let currentRevision = 0;
        if (row?.value) {
          try {
            const parsed: unknown = JSON.parse(row.value);
            if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0) {
              currentRevision = parsed;
            }
          } catch {
            // Keep legacy fallback behavior.
          }
        }
        if (expectedRevision !== undefined && expectedRevision !== currentRevision) {
          throw new SettingsRevisionConflictError(currentRevision);
        }
        for (const update of updates) {
          insert.run(update.namespace ?? "settings", update.key, update.value);
        }
        insert.run("settings", "_settingsRevision", JSON.stringify(currentRevision + 1));
        return currentRevision + 1;
      });
      return transaction();
    },
  };
}

/**
 * PostgreSQL adapter. Unconditional writes retry revision conflicts so normal
 * settings PATCH requests retain last-writer-wins behavior. Explicit revisions
 * remain strict compare-and-swap operations.
 */
export function createPostgresSettingsStorage(db: AsyncDatabase): SettingsStorage {
  const repository = createPostgresSettingsRepository(db);
  return {
    backend: "postgres",
    async read() {
      const snapshot = await repository.read();
      return {
        rows: snapshot.settings.filter((row) => row.namespace === "settings"),
        revision: snapshot.revision,
      };
    },

    async update(updates, expectedRevision) {
      const normalized: PostgresSettingsUpdate[] = updates.map((update) => ({
        namespace: update.namespace,
        key: update.key,
        value: update.value,
      }));
      if (expectedRevision !== undefined) {
        return repository.update(expectedRevision, normalized);
      }

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const current = await repository.read();
        try {
          return await repository.update(current.revision, normalized);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            (error as Error & { code?: string }).code !== "SETTINGS_REVISION_CONFLICT" ||
            attempt === 7
          ) {
            throw error;
          }
        }
      }
      throw new Error("Unable to serialize settings update after repeated revision conflicts");
    },
  };
}

let configuredStorage: SettingsStorage | undefined;

/** Configure once during server composition, before settings are first accessed. */
export function configureSettingsStorage(storage: SettingsStorage): void {
  if (!storage || typeof storage.read !== "function" || typeof storage.update !== "function") {
    throw new TypeError("A valid SettingsStorage implementation is required");
  }
  configuredStorage = storage;
}

export function getSettingsStorage(): SettingsStorage {
  return configuredStorage ?? createSqliteSettingsStorage(getDbInstance());
}

/** Test/process teardown hook. Production code should configure once at startup. */
export function resetSettingsStorage(): void {
  configuredStorage = undefined;
}
