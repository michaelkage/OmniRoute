/**
 * Structural PostgreSQL contracts.
 *
 * The database layer deliberately does not import a concrete driver. Production
 * composition supplies a pg.Pool-compatible instance; tests can supply a fake.
 * This keeps driver loading out of Next.js build workers and preserves the
 * repository's optional/native dependency loading rules.
 */

export type SqlPrimitive = string | number | boolean | Date | Buffer | null;
export type SqlParameter = SqlPrimitive | readonly SqlPrimitive[];

export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
  command?: string;
  fields?: readonly unknown[];
}

export interface Queryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
}

export interface PoolClient extends Queryable {
  release(error?: Error | boolean): void;
}

export interface Pool extends Queryable {
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

export type TransactionIsolation = "read committed" | "repeatable read" | "serializable";

export interface TransactionOptions {
  isolation?: TransactionIsolation;
  readOnly?: boolean;
  deferrable?: boolean;
  retries?: number;
}

export interface AsyncDatabase extends Queryable {
  transaction<T>(
    callback: (tx: Queryable) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number }>;
  close(): Promise<void>;
}
