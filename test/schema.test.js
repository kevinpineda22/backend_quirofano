import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("tablas y RPC del servicio usan el prefijo quirofano_ y existen en la migracion", async () => {
  const [sql, service] = await Promise.all([
    readFile(new URL("../sql/001_quirofano.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/service.js", import.meta.url), "utf8"),
  ]);
  const tables = [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((match) => match[1]);
  const functions = [...sql.matchAll(/create or replace function public\.(\w+)/g)].map((match) => match[1]);
  assert.equal(tables.length, 10);
  assert.equal(functions.length, 7);
  assert.ok([...tables, ...functions].every((name) => name.startsWith("quirofano_")));
  assert.doesNotMatch(sql, /\bqf_/);
  assert.doesNotMatch(service, /["']qf_/);
  for (const [, method, name] of service.matchAll(/repo\.(all|one|list|upsert|insert|update|rpc)\("([^"]+)"/g)) {
    assert.ok((method === "rpc" ? functions : tables).includes(name), `${method}: ${name} no existe en el SQL`);
  }
});
