import { test } from "node:test";
import assert from "node:assert/strict";
import { createService } from "../src/service.js";
import { priceFingerprint } from "../src/domain/pricing.js";
import { ACTOR_ID, INVOICE_ID, LIQUIDATION_ID, PRODUCT_ID, invoice, product, storedProduct, taxes } from "./fixtures.js";

function setup({ remoteChanges = {}, writeError, writesEnabled = true, savedStatus = "draft" } = {}) {
  const calls = [];
  const remote = { ...structuredClone(product), ...remoteChanges };
  const liquidation = {
    id: LIQUIDATION_ID, product_id: PRODUCT_ID, product_code: "ABC", product_name: product.name,
    status: savedStatus, list_position: 1, fingerprint: priceFingerprint(product),
    params: { cost: 7000, taxRate: 19 }, calculation: { suggested: 15000 },
    proposed_value: 15000, previous_value: 11900, cost_source: "purchase", cost_date: "2026-11-16",
    approved_at: "2026-11-17T10:00:00Z",
  };
  const repo = {
    configured: true,
    one: async (table) => table === "quirofano_products" ? structuredClone(storedProduct) : structuredClone(liquidation),
    list: async () => [],
    all: async () => [],
    upsert: async () => {},
    update: async () => {},
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "quirofano_claim_price") return structuredClone(liquidation);
      if (name === "quirofano_finish_price") {
        liquidation.status = args.p_status;
        return { ...liquidation, error: args.p_error };
      }
      if (name === "quirofano_acquire_sync") return true;
      return args;
    },
  };
  const siigo = {
    configured: true, writesEnabled,
    taxes: async () => taxes,
    product: async () => structuredClone(remote),
    purchase: async () => invoice,
    updateProduct: async (_id, payload) => {
      calls.push({ name: "PUT", payload });
      if (writeError) throw writeError;
      remote.prices = payload.prices;
    },
  };
  const service = createService({ repo, siigo, now: () => new Date("2026-11-17T20:00:00Z") });
  return { service, repo, siigo, calls, liquidation };
}
test("aprobacion exitosa verifica lectura posterior y conserva las otras listas", async () => {
  const { service, calls } = setup();
  const { results } = await service.approve([LIQUIDATION_ID], ACTOR_ID);
  assert.equal(results[0].status, "applied");
  assert.equal(calls.filter((c) => c.name === "PUT").length, 1);
  assert.equal(calls.find((c) => c.name === "PUT").payload.prices[0].price_list[1].value, 11000);
  assert.equal(calls.at(-1).args.p_status, "applied");
});
test("un precio cambiado antes de aprobar bloquea la escritura", async () => {
  const changed = structuredClone(product.prices);
  changed[0].price_list[1].value = 9999;
  const { service, calls } = setup({ remoteChanges: { prices: changed } });
  const { results } = await service.approve([LIQUIDATION_ID], ACTOR_ID);
  assert.equal(results[0].status, "conflict");
  assert.equal(calls.some((c) => c.name === "PUT"), false);
});
test("costo actualizado despues de guardar invalida la aprobacion", async () => {
  const { service, repo, calls, liquidation } = setup();
  repo.one = async (table) => table === "quirofano_products" ? { ...storedProduct, purchase_cost: 8000 } : liquidation;
  const { results } = await service.approve([LIQUIDATION_ID], ACTOR_ID);
  assert.equal(results[0].status, "conflict");
  assert.equal(calls.some((c) => c.name === "PUT"), false);
});
test("timeout de escritura queda en revision; no se repite el PUT", async () => {
  const { service, calls } = setup({ writeError: new Error("Timeout") });
  const { results } = await service.approve([LIQUIDATION_ID], ACTOR_ID);
  assert.equal(results[0].status, "review");
  assert.equal(calls.filter((c) => c.name === "PUT").length, 1);
});
test("cambio de porcentaje de IVA invalida incluso si los IDs son iguales", async () => {
  const { service, siigo, calls } = setup();
  siigo.taxes = async () => [{ ...taxes[0], percentage: 5 }];
  const { results } = await service.approve([LIQUIDATION_ID], ACTOR_ID);
  assert.equal(results[0].status, "conflict");
  assert.equal(calls.some((c) => c.name === "PUT"), false);
});
test("repetir aprobacion de un aplicado no escribe nuevamente", async () => {
  const { service, calls } = setup({ savedStatus: "applied" });
  assert.equal((await service.approve([LIQUIDATION_ID], ACTOR_ID)).results[0].status, "applied");
  assert.equal(calls.length, 0);
});
test("modo protegido no reclama el registro ni permite escrituras", async () => {
  const { service, calls } = setup({ writesEnabled: false });
  assert.equal((await service.approve([LIQUIDATION_ID], ACTOR_ID)).results[0].status, "error");
  assert.equal(calls.length, 0);
});
test("verificar sin coincidencia deja revision y jamas escribe", async () => {
  const { service, calls } = setup({ savedStatus: "review" });
  const result = await service.verify(LIQUIDATION_ID, ACTOR_ID);
  assert.equal(result.status, "review");
  assert.equal(calls.some((c) => c.name === "PUT"), false);
});
test("verificar coincidencia posterior resuelve el resultado incierto sin escribir", async () => {
  const prices = structuredClone(product.prices);
  prices[0].price_list[0].value = 15000;
  const { service, calls } = setup({ savedStatus: "review", remoteChanges: { prices } });
  assert.equal((await service.verify(LIQUIDATION_ID, ACTOR_ID)).status, "applied");
  assert.equal(calls.some((c) => c.name === "PUT"), false);
});
test("rechaza aprobaciones masivas no acotadas e identificadores invalidos", async () => {
  const { service } = setup();
  await assert.rejects(service.approve([LIQUIDATION_ID, LIQUIDATION_ID], ACTOR_ID));
  await assert.rejects(service.registerPurchase({ id: "123", taxIncluded: true }, ACTOR_ID), /UUID/);
  await assert.rejects(service.analysis({ from: "2026-01-01", to: "2026-11-17" }), /rango/);
});
test("guardar recalcula en servidor e ignora costos y precios manipulados de origen compra", async () => {
  const { service, repo, calls } = setup();
  repo.one = async (table) => table === "quirofano_catalogs"
    ? { data: [{ position: 1, active: true }] } : structuredClone(storedProduct);
  await service.saveLiquidations({ position: 1, items: [{
    productId: PRODUCT_ID, costSource: "purchase", cost: 1, proposed_value: 1,
    currentPrice: 1, taxRate: 0, mode: "margin", target: 30,
  }] }, ACTOR_ID);
  const row = calls.find((c) => c.name === "quirofano_save_liquidations").args.p_rows[0];
  assert.equal(row.params.cost, 7000);
  assert.equal(row.params.taxRate, 19);
  assert.equal(row.calculation.suggested, 11900);
  assert.equal(row.proposed_value, 11900);
});
test("sincronizacion de compras solo persiste despues de validar y libera el bloqueo", async () => {
  const { service, repo, calls } = setup();
  let queries = 0;
  repo.list = async () => ++queries === 1 ? [{ id: INVOICE_ID, tax_included: true }] : [];
  const result = await service.syncPurchases();
  assert.equal(result.results[0].status, "synced");
  assert.equal(calls.find((c) => c.name === "quirofano_replace_purchase").args.p_lines[0].unit_cost, 9000);
  assert.equal(calls.at(-1).name, "quirofano_release_sync");
});
test("fallo de factura mantiene error visible y no guarda renglones parciales", async () => {
  const { service, repo, siigo, calls } = setup();
  let queries = 0;
  repo.list = async () => ++queries === 1 ? [{ id: INVOICE_ID, tax_included: true }] : [];
  siigo.purchase = async () => ({ ...invoice, currency: { code: "USD" } });
  const result = await service.syncPurchases();
  assert.equal(result.results[0].status, "error");
  assert.equal(calls.some((c) => c.name === "quirofano_replace_purchase"), false);
});
