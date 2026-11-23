import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConnection } from "../scripts/check-connection.js";

function setup({ databaseError = null, taxes = [] } = {}) {
  const calls = [];
  const db = {
    from: (table) => ({
      select: (column) => ({
        limit: async (limit) => {
          calls.push({ table, column, limit });
          return { error: databaseError };
        },
      }),
    }),
  };
  const siigo = {
    taxes: async () => { calls.push("taxes"); return taxes; },
    priceLists: async () => { calls.push("priceLists"); return []; },
    products: async (page) => {
      calls.push({ page });
      return { results: [], pagination: { total_results: 0 } };
    },
  };
  return { db, siigo, calls, report: () => {} };
}

test("diagnostico consulta las diez tablas quirofano_ y solo lecturas de Siigo", async () => {
  const context = setup();
  await checkConnection(context);
  const queries = context.calls.filter((call) => call.table);
  assert.equal(queries.length, 10);
  assert.equal(new Set(queries.map((query) => query.table)).size, 10);
  assert.ok(queries.every((query) => query.table.startsWith("quirofano_") && query.column === "id" && query.limit === 1));
  assert.deepEqual(context.calls.slice(10), ["taxes", "priceLists", { page: 1 }]);
});

test("diagnostico falla explicitamente si falta una tabla sin mostrar detalles privados", async () => {
  const context = setup({ databaseError: { code: "42P01", message: "private-detail" } });
  await assert.rejects(checkConnection(context), (error) =>
    error.message.includes("quirofano_products") && error.message.includes("42P01") && !error.message.includes("private-detail"));
  assert.equal(context.calls.length, 1);
});

test("diagnostico rechaza catalogos de Siigo con formato inesperado", async () => {
  await assert.rejects(checkConnection(setup({ taxes: {} })), /formato no reconocido/);
});

test("diagnostico no reporta exito ante una autenticacion fallida en Siigo", async () => {
  const context = setup();
  context.siigo.taxes = async () => { throw new Error("Siigo rechazo la autenticacion (401)."); };
  await assert.rejects(checkConnection(context), /autenticacion/);
});
