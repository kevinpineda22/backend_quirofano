import { test } from "node:test";
import assert from "node:assert/strict";
import { createPriceEditor } from "../src/priceEditor.js";
import { DomainError } from "../src/domain/pricing.js";
import { ACTOR_ID, LIQUIDATION_ID, PRODUCT_ID, product, storedProduct, taxes } from "./fixtures.js";

function setup({ enabled = true, storage = true, writes = true, taxIncluded = true, writeError } = {}) {
  const remote = { ...structuredClone(product), tax_included: taxIncluded };
  remote.prices[0].price_list[0].value = taxIncluded ? 66000 : 10000;
  const calls = [], events = [], tables = new Map();
  let cost = 59400, saved;
  const reader = {
    pricingContext: async (id, confirmations, fresh) => {
      calls.push({ type: "read", id, confirmations, fresh });
      return { product: { ...storedProduct, purchase_cost: cost, payload: structuredClone(remote) },
        taxes, lists: [{ position: 1, active: true }, { position: 2, active: true }] };
    },
    invalidate: () => { calls.push({ type: "invalidate" }); },
  };
  const repo = {
    configured: storage,
    upsert: async (table, data) => { tables.set(table, structuredClone(data)); },
    one: async (table) => structuredClone(table === "quirofano_liquidations" ? saved
      : table === "quirofano_products" ? tables.get(table) : { data: tables.get(table).find((row) => row.id === "price_lists").data }),
    update: async (table, _id, fields) => { tables.set(table, { ...tables.get(table), ...structuredClone(fields) }); },
    all: async () => saved ? [structuredClone(saved)] : [],
    rpc: async (name, args) => {
      if (name === "quirofano_save_liquidations") {
        saved = { ...structuredClone(args.p_rows[0]), id: LIQUIDATION_ID, status: "draft",
          created_at: "2026-11-23T12:00:00Z", created_by: args.p_actor };
        events.push("created");
        return [structuredClone(saved)];
      }
      if (name === "quirofano_claim_price") {
        if (saved.status !== "draft") throw new DomainError("El registro cambio de estado.", 409);
        saved.status = "applying"; saved.approved_by = args.p_actor; saved.approved_at = "2026-11-23T12:00:00Z";
        events.push("approved");
        return structuredClone(saved);
      }
      if (name === "quirofano_finish_price") {
        saved.status = args.p_status; saved.error = args.p_error;
        events.push(args.p_status);
        return structuredClone(saved);
      }
      throw new Error(`Unexpected RPC: ${name}`);
    },
  };
  const siigo = {
    configured: true, writesEnabled: writes,
    product: async () => structuredClone(remote), taxes: async () => taxes,
    updateProduct: async (_id, payload) => {
      calls.push({ type: "PUT", payload: structuredClone(payload) });
      if (writeError) throw writeError;
      remote.prices = structuredClone(payload.prices);
    },
  };
  const editor = createPriceEditor({ reader, repo, siigo, enabled, now: () => new Date("2026-11-23T14:00:00Z") });
  return { editor, reader, repo, calls, events, remote, changeCost: (value) => { cost = value; } };
}
test("preparar recalcula en servidor, incorpora IVA, redondea y no escribe hasta confirmar", async () => {
  const { editor, calls, events } = setup();
  const draft = await editor.prepare(PRODUCT_ID, { position: 1, target: 30, cost: 1, taxRate: 0, roundStep: 1 }, ACTOR_ID);
  assert.equal(draft.params.cost, 59400);
  assert.equal(draft.params.taxRate, 19);
  assert.equal(draft.calculation.suggested, 101000);
  assert.equal(draft.calculation.currentMargin, -7.1);
  assert.ok(draft.calculation.margin >= 30);
  assert.deepEqual(events, ["created"]);
  assert.equal(calls.some((call) => call.type === "PUT"), false);
  assert.equal(calls[0].fresh, true);
});
test("aplicar verifica Siigo, conserva otras listas/monedas y repetir el mismo cambio no escribe otra vez", async () => {
  const { editor, calls, events, remote } = setup();
  const draft = await editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID);
  assert.equal((await editor.apply(draft.id, ACTOR_ID)).status, "applied");
  assert.equal((await editor.apply(draft.id, ACTOR_ID)).status, "applied");
  assert.equal(calls.filter((call) => call.type === "PUT").length, 1);
  assert.equal(remote.prices[0].price_list[0].value, 101000);
  assert.equal(remote.prices[0].price_list[1].value, 11000);
  assert.equal(remote.prices[1].price_list[0].value, 3);
  assert.deepEqual(events, ["created", "approved", "applied"]);
  assert.equal(calls.filter((call) => call.type === "read").length, 2);
});
test("si Siigo guarda el precio sin IVA convierte el final al valor neto correcto", async () => {
  const { editor, remote } = setup({ taxIncluded: false });
  const draft = await editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID);
  assert.equal(draft.calculation.suggested, 101000);
  assert.equal((await editor.apply(draft.id, ACTOR_ID)).status, "applied");
  assert.equal(remote.prices[0].price_list[0].value, 84873.95);
});
test("el editor guarda y aplica ganancia fija o precio final exacto usando el ultimo costo real", async () => {
  for (const [mode, target, expected] of [["fixed", 5000, 76700], ["price", 90001, 90001]]) {
    const { editor, remote } = setup();
    const draft = await editor.prepare(PRODUCT_ID, { position: 1, mode, target, cost: 1 }, ACTOR_ID);
    assert.equal(draft.params.cost, 59400);
    assert.equal(draft.params.mode, mode);
    assert.equal(draft.calculation.suggested, expected);
    assert.equal((await editor.apply(draft.id, ACTOR_ID)).status, "applied");
    assert.equal(remote.prices[0].price_list[0].value, expected);
  }
});
test("portafolio previsualiza todos los productos y muestra los no liquidables sin crear propuestas ni escribir", async () => {
  const { editor, reader, calls, events } = setup();
  reader.productScope = async () => ({ rows: [
    { ...storedProduct, purchase_cost: 59400 },
    { ...storedProduct, id: "55555555-5555-4555-8555-555555555555", code: "OFF", purchase_cost: null, cost_error: "Sin compras" },
  ], lists: [{ position: 1, active: true }], readAt: "2026-11-23T14:00:00Z", supplierIssues: [] });
  const result = await editor.previewScope({ scope: { type: "category", value: "Abarrotes" }, mode: "price", target: 90001, position: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.eligible, 1);
  assert.equal(result.rows[0].calculation.suggested, 90001);
  assert.equal(result.rows[0].expected.cost, 59400);
  assert.equal(result.rows[1].error, "Sin compras");
  assert.deepEqual(events, []);
  assert.equal(calls.some((call) => call.type === "PUT"), false);
});
test("preparar desde un portafolio rechaza una vista previa cuyo costo cambio", async () => {
  const { editor, events, calls, changeCost } = setup();
  const draft = await editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID);
  changeCost(60000);
  await assert.rejects(editor.prepare(PRODUCT_ID, { position: 1, target: 30, expected: {
    fingerprint: draft.fingerprint, cost: draft.params.cost, costDate: draft.cost_date, taxRate: draft.params.taxRate,
  } }, ACTOR_ID), /vista previa del portafolio/);
  assert.deepEqual(events, ["created"]);
  assert.equal(calls.some((call) => call.type === "PUT"), false);
});
test("un costo nuevo o un precio cambiado tras preparar bloquea el PUT y conserva la propuesta historica", async () => {
  for (const kind of ["cost", "price"]) {
    const { editor, calls, changeCost, remote } = setup();
    const draft = await editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID);
    if (kind === "cost") changeCost(60000);
    else remote.prices[0].price_list[0].value = 12500;
    assert.equal((await editor.apply(draft.id, ACTOR_ID)).status, "conflict");
    assert.equal(calls.some((call) => call.type === "PUT"), false);
    const history = await editor.history(PRODUCT_ID);
    assert.equal(history.rows[0].params.cost, 59400);
    assert.equal(history.appliedCount, 0);
  }
});
test("un timeout queda en revision; verificar no repite la escritura y no permite aplicar de nuevo", async () => {
  const { editor, calls } = setup({ writeError: new Error("Timeout") });
  const draft = await editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID);
  assert.equal((await editor.apply(draft.id, ACTOR_ID)).status, "review");
  await assert.rejects(editor.apply(draft.id, ACTOR_ID), /ya fue enviado/);
  assert.equal((await editor.verify(draft.id, ACTOR_ID)).status, "review");
  assert.equal(calls.filter((call) => call.type === "PUT").length, 1);
});
test("configuracion incompleta bloquea la escritura y no inventa un historial vacio", async () => {
  const noStorage = setup({ storage: false });
  await assert.rejects(noStorage.editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID), /SUPABASE_ANON_KEY/);
  await assert.rejects(noStorage.editor.history(PRODUCT_ID), /Historial de precios no disponible/);
  const disabled = setup({ enabled: false });
  await assert.rejects(disabled.editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID), /deshabilitada/);
  const protectedMode = setup({ writes: false });
  const draft = await protectedMode.editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID);
  await assert.rejects(protectedMode.editor.apply(draft.id, ACTOR_ID), /deshabilitadas/);
  assert.equal(protectedMode.calls.some((call) => call.type === "PUT"), false);
});
test("validaciones financieras y confirmaciones se conservan al preparar y revalidar", async () => {
  const { editor, calls, changeCost } = setup();
  for (const target of ["", -1, 100, "abc"]) {
    await assert.rejects(editor.prepare(PRODUCT_ID, { position: 1, target }, ACTOR_ID), /Margen/);
  }
  const taxConfirmations = { invoice: true };
  const draft = await editor.prepare(PRODUCT_ID, { position: 1, target: 30, taxConfirmations }, ACTOR_ID);
  assert.deepEqual(draft.params.taxConfirmations, taxConfirmations);
  await editor.apply(draft.id, ACTOR_ID);
  assert.deepEqual(calls.filter((call) => call.type === "read").map((call) => call.confirmations), [taxConfirmations, taxConfirmations]);
  changeCost(null);
  await assert.rejects(editor.prepare(PRODUCT_ID, { position: 1, target: 30 }, ACTOR_ID), /no tiene costo/);
});
