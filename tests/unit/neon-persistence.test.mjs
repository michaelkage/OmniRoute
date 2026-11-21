import test from "node:test";
import assert from "node:assert/strict";
import { parseInterval, parsePostgresConnection, parseRetention } from "../../scripts/neon/persistence.mjs";

test("snapshot retention clamps to the supported range", () => {
  assert.equal(parseRetention("0"), 1);
  assert.equal(parseRetention("12"), 12);
  assert.equal(parseRetention("999"), 100);
  assert.equal(parseRetention("invalid"), 12);
});

test("snapshot interval has a one-minute floor", () => {
  assert.equal(parseInterval("1"), 60000);
  assert.equal(parseInterval("120000"), 120000);
  assert.equal(parseInterval("invalid"), 300000);
});

test("PostgreSQL URL parsing decodes credentials and defaults to TLS", () => {
  const env = parsePostgresConnection("postgresql://user%40name:p%40ss%3Aword@ep.example.neon.tech:5433/app?channel_binding=require");
  assert.equal(env.PGHOST, "ep.example.neon.tech");
  assert.equal(env.PGPORT, "5433");
  assert.equal(env.PGUSER, "user@name");
  assert.equal(env.PGPASSWORD, "p@ss:word");
  assert.equal(env.PGDATABASE, "app");
  assert.equal(env.PGSSLMODE, "require");
  assert.equal(env.PGCHANNELBINDING, "require");
});

test("PostgreSQL URL parser rejects non-PostgreSQL protocols", () => {
  assert.throws(() => parsePostgresConnection("https://example.com"), /postgres/);
});
