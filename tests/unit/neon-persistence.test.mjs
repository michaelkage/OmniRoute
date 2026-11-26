import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBase64Decoder, createBase64Encoder, parseInterval, parsePostgresConnection, parseRetention } from "../../scripts/neon/persistence.mjs";

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

test("streaming base64 encoder preserves payload across arbitrary chunk boundaries", async () => {
  const input = [
    Buffer.from("SQLite stream "),
    Buffer.from("crosses "),
    Buffer.from("chunk boundaries."),
    Buffer.from([0, 1, 2, 253, 254, 255]),
  ];
  const expected = Buffer.concat(input).toString("base64");
  const output = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output.push(Buffer.from(chunk));
      callback();
    },
  });

  await pipeline(Readable.from(input), createBase64Encoder(), sink);
  assert.equal(Buffer.concat(output).toString("ascii"), expected);
});


test("streaming base64 decoder handles arbitrary chunks and COPY newlines", async () => {
  const payload = Buffer.from("snapshot restore across chunk boundaries");
  const encoded = Buffer.from(payload.toString("base64") + "\n");
  const chunks = [];
  for (let i = 0; i < encoded.length; i += 5) chunks.push(encoded.subarray(i, i + 5));
  const output = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      output.push(Buffer.from(chunk));
      callback();
    },
  });
  await pipeline(Readable.from(chunks), createBase64Decoder(), sink);
  assert.deepEqual(Buffer.concat(output), payload);
});
