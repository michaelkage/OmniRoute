/**
 * Runtime-neutral API contracts.
 *
 * Keep these shapes free of framework, database, provider-executor, and Node APIs.
 * They describe data crossing a process or package boundary.
 */

export interface ApiErrorContract {
  status: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
