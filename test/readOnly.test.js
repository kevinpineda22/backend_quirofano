import { test } from "node:test";
import assert from "node:assert/strict";
import { createReadOnlyService } from "../src/readOnlyService.js";
import { invoice, product, taxes } from "./fixtures.js";

function setup() {
  const calls = [];
  let time = Date.parse("2026-11-18T12:00:00Z");
  const siigo = {
    configured: true,
    product: async () => product,
    taxes: async () => taxes,
    priceLists: async () => [{ position: 1, active: true }],
    products: async (page) => {
      calls.push(page);
      return { pagination: { total_results: 2 },
        results: [page === 1 ? product : { ...product, id: "inactive", code: "OFF", active: false }] };
    },
    purchases: async () => ({ pagination: { total_results: 1 }, results: [invoice] }),
  };
  const service = createReadOnlyService({ siigo, now: () => time });
  return { service, siigo, calls, advance: () => { time += 60001; } };
}

test("consulta todas las paginas y calcula costo neto y margen con la compra de Siigo", async () => {
  const { service, calls } = setup();
  const meta = await service.meta();
  assert.equal(meta.readOnly, true);
  assert.equal(meta.writesEnabled, false);
  assert.deepEqual(meta.summary, { products: 2, active: 1, inactive: 1, priceLists: 1 });
  const data = await service.products({ search: "ABC" });
  assert.equal(data.total, 1);
  assert.equal(data.items[0].purchase_cost, 9000);
  assert.equal(data.items[0].cost_date, "2026-11-17");
  assert.equal(data.items[0].margin, 10);
  assert.equal((await service.products({ position: 2 })).items[0].margin, 2.64);
  assert.equal(data.items[0].price, 11900);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(service.saveLiquidations, undefined);
  assert.equal(service.approve, undefined);
});
test("usa la ultima fecha ponderada, ignora compras futuras/anuladas y no bloquea por IVA pendiente antiguo", async () => {
  const { service, siigo } = setup();
  const documents = [
    { ...invoice, id: "old", date: "2026-11-16", tax_included: undefined },
    invoice,
    { ...invoice, id: "same-day", tax_included: false,
      items: [{ type: "Product", code: "ABC", quantity: 1, price: 6000 }] },
    { ...invoice, id: "void", date: "2026-11-18", annulled: true },
    { ...invoice, id: "future", date: "2026-11-19" },
  ];
  siigo.purchases = async () => ({ pagination: { total_results: documents.length }, results: documents });
  const row = (await service.products()).items[0];
  assert.equal(row.purchase_cost, 8000);
  assert.equal(row.cost_date, "2026-11-17");
  assert.equal(row.margin, 20);
  assert.equal(row.cost_error, null);
});
test("proveedor incluye todo su portafolio historico, incluso con otro proveedor mas reciente y mas de una pagina", async () => {
  const { service, siigo } = setup();
  const products = Array.from({ length: 35 }, (_, index) => ({ ...product,
    id: `11111111-1111-4111-8111-${String(index + 10).padStart(12, "0")}`, code: `P${index}`, name: `Producto ${index}` }));
  siigo.products = async () => ({ pagination: { total_results: products.length }, results: products });
  const old = { ...invoice, id: "old", date: "2026-11-16", supplier: { identification: "900", name: ["Proveedor", "Anterior"] },
    tax_included: false, items: products.map((p) => ({ type: "Product", code: p.code, quantity: 1, price: 7000 })) };
  const recent = { ...old, id: "recent", date: "2026-11-17", supplier: { identification: "901", name: "Proveedor Actual" },
    items: old.items.map((item) => ({ ...item, price: 8000 })) };
  const ghost = { ...old, id: "void", annulled: true, supplier: { identification: "999", name: "Anulado" } };
  siigo.purchases = async () => ({ pagination: { total_results: 3 }, results: [old, recent, ghost] });
  const data = await service.products({ supplier: "900", page: 2 });
  assert.equal(data.total, 35);
  assert.equal(data.items.length, 5);
  assert.equal(data.items[0].purchase_cost, 8000);
  assert.equal(data.suppliers.length, 2);
  const scope = await service.productScope({ type: "supplier", value: "900" });
  assert.equal(scope.rows.length, 35);
  assert.equal((await service.productScope({ type: "category", value: "Abarrotes" })).rows.length, 35);
  assert.equal((await service.purchases({ supplier: "900", search: "Proveedor Anterior" })).total, 35);
  await assert.rejects(service.productScope({ type: "supplier", value: "" }), /Seleccione/);
});
test("la alerta usa margen real menor a 20%, no el redondeado ni un margen faltante", async () => {
  const { service, siigo } = setup();
  const products = [product, { ...product, id: "near", code: "NEAR" }, { ...product, id: "missing", code: "MISSING" }];
  siigo.products = async () => ({ pagination: { total_results: 3 }, results: products });
  siigo.purchases = async () => ({ pagination: { total_results: 1 }, results: [{
    ...invoice, tax_included: false, items: [
      { type: "Product", code: "ABC", price: 8000, quantity: 1 },
      { type: "Product", code: "NEAR", price: 8000.004, quantity: 1000 },
    ],
  }] });
  const data = await service.products();
  assert.deepEqual(data.alerts, { below20: 1, withoutMargin: 1 });
  assert.equal(data.items.find((p) => p.code === "ABC").marginAlert, false);
  assert.equal(data.items.find((p) => p.code === "NEAR").margin, 20);
  assert.equal(data.items.find((p) => p.code === "NEAR").marginAlert, true);
  const filtered = await service.products({ onlyLowMargin: true });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].code, "NEAR");
});
test("si compras no trae nombres, consulta terceros y comparte el cache sin perder la busqueda por proveedor", async () => {
  const { service, siigo } = setup();
  let calls = 0;
  siigo.purchases = async () => ({ pagination: { total_results: 1 }, results: [{
    ...invoice, supplier: { id: "supplier-uuid", identification: "900123" },
  }] });
  siigo.customer = async (id) => { calls++; return { id, name: ["Proveedor", "Consultado"] }; };
  const products = await service.products({ supplier: "900123" });
  assert.equal(products.suppliers[0].name, "Proveedor Consultado");
  assert.equal((await service.purchases({ search: "Proveedor Consultado" })).total, 1);
  await service.pricingContext(product.id, {}, true);
  assert.equal(calls, 1);
});
test("un tercero incompleto deja visible el error de proveedor sin inventar su nombre ni perder costos", async () => {
  const { service, siigo } = setup();
  siigo.purchases = async () => ({ pagination: { total_results: 1 }, results: [{
    ...invoice, supplier: { id: "supplier-uuid", identification: "900123" },
  }] });
  siigo.customer = async (id) => ({ id });
  const data = await service.products();
  assert.equal(data.items[0].purchase_cost, 9000);
  assert.equal(data.suppliers[0].name, "");
  assert.match(data.supplierIssues[0], /No se pudo consultar el nombre/);
});
test("no reutiliza costo anterior si la compra mas reciente tiene moneda/impuestos no soportados", async () => {
  for (const change of [
    { currency: { code: "USD" } },
    { items: [{ type: "Product", code: "ABC", quantity: 1, price: 100, taxes: [{ id: 99 }] }] },
  ]) {
    const { service, siigo } = setup();
    const recent = { ...invoice, id: "recent", date: "2026-11-18", ...change };
    siigo.purchases = async () => ({ pagination: { total_results: 2 }, results: [invoice, recent] });
    const row = (await service.products()).items[0];
    assert.equal(row.purchase_cost, null);
    assert.equal(row.margin, null);
    assert.ok(row.cost_error);
  }
});
test("sin compras muestra el motivo y con error de Siigo no inventa un catalogo exitoso", async () => {
  const { service, siigo } = setup();
  siigo.purchases = async () => ({ pagination: { total_results: 0 }, results: [] });
  const row = (await service.products()).items[0];
  assert.equal(row.purchase_cost, null);
  assert.equal(row.margin, null);
  assert.match(row.cost_error, /Sin compras/);
  await service.refresh();
  siigo.purchases = async () => { throw new Error("Fallo de compras Siigo"); };
  await assert.rejects(service.products(), /Fallo de compras Siigo/);
});
test("muestra perdidas y conserva el costo sin inventar margen si falta la lista de venta", async () => {
  const { service, siigo } = setup();
  siigo.purchases = async () => ({ pagination: { total_results: 1 }, results: [{
    ...invoice, tax_included: false,
    items: [{ type: "Product", code: "ABC", quantity: 1, price: 12000 }],
  }] });
  const loss = (await service.products()).items[0];
  assert.equal(loss.purchase_cost, 12000);
  assert.equal(loss.margin, -20);
  const noPrice = (await service.products({ position: 3 })).items[0];
  assert.equal(noPrice.purchase_cost, 12000);
  assert.equal(noPrice.price, null);
  assert.equal(noPrice.margin, null);
});
test("sin indicador de IVA usa costo sin IVA, permite confirmaciones por solicitud y Siigo prevalece", async () => {
  const { service, siigo } = setup();
  siigo.purchases = async () => ({ pagination: { total_results: 1 }, results: [{ ...invoice, tax_included: undefined }] });
  const row = (await service.products()).items[0];
  assert.equal(row.purchase_cost, 10710);
  assert.equal(row.margin, -7.1);
  assert.equal(row.cost_error, null);
  assert.equal((await service.products({}, { [invoice.id]: true })).items[0].purchase_cost, 9000);
  assert.equal((await service.products({}, { [invoice.id]: false })).items[0].purchase_cost, 10710);
  assert.equal((await service.products()).items[0].purchase_cost, 10710);
  await assert.rejects(service.products({}, { [invoice.id]: "true" }), /Confirmacion/);
  await assert.rejects(service.products({}, { missing: true }), /Confirmacion/);
  await assert.rejects(service.products(null), /Filtros/);
  await service.refresh();
  siigo.purchases = async () => ({ pagination: { total_results: 1 }, results: [invoice] });
  assert.equal((await service.products({}, { [invoice.id]: false })).items[0].purchase_cost, 9000);
});
test("consultas concurrentes comparten lectura y el cache vence o se actualiza explicitamente", async () => {
  const { service, calls, advance } = setup();
  await Promise.all([service.meta(), service.products(), service.meta()]);
  assert.deepEqual(calls, [1, 2]);
  advance();
  await service.meta();
  assert.deepEqual(calls, [1, 2, 1, 2]);
  await service.refresh();
  assert.equal(calls.length, 6);
});
test("compras conserva valores y descuentos originales sin afirmar un costo neto", async () => {
  const { service, siigo } = setup();
  siigo.purchases = async () => {
    const raw = structuredClone(invoice);
    delete raw.tax_included;
    return { pagination: { total_results: 1 }, results: [raw] };
  };
  const data = await service.purchases({ search: "ABC", from: "2026-11-17", to: "2026-11-17" });
  assert.deepEqual(data.summary, { invoices: 1, lines: 1, products: 1 });
  assert.equal(data.items[0].unit_price, 11900);
  assert.deepEqual(data.items[0].discount, { value: 2380 });
  assert.equal(data.items[0].tax_included, null);
  assert.equal(data.items[0].currency, null);
  assert.equal(data.items[0].net_total, undefined);
  assert.equal((await service.purchases({ search: "no existe" })).total, 0);
  await assert.rejects(service.purchases({ page: 0 }), /Pagina/);
  await assert.rejects(service.purchases({ from: "2026-11-19", to: "2026-11-18" }), /rango/);
});
test("no presenta totales parciales cuando Siigo devuelve duplicados, paginas vacias o cambios", async () => {
  for (const kind of ["duplicate", "empty", "changed"]) {
    const { service, siigo } = setup();
    siigo.products = async (page) => ({
      pagination: { total_results: kind === "changed" && page > 1 ? 3 : 2 },
      results: page > 1 && kind === "empty" ? [] : [product],
    });
    await assert.rejects(service.meta(), /duplicados|incompleta|cambio/);
  }
});
test("los errores no se convierten en catalogos vacios ni en cache de exito", async () => {
  const { service, siigo } = setup();
  const original = siigo.products;
  siigo.products = async () => { throw new Error("Siigo no disponible"); };
  await assert.rejects(service.meta(), /Siigo no disponible/);
  siigo.products = original;
  assert.equal((await service.meta()).summary.products, 2);
  siigo.purchases = async () => ({ results: [], pagination: { total_results: 1001 } });
  await assert.rejects(service.purchases(), /supera 1000/);
});
test("analitica lee ventas reales y las confirmaciones de IVA no se comparten entre solicitudes", async () => {
  const { service, siigo } = setup();
  const pending = structuredClone(invoice);
  delete pending.tax_included;
  siigo.purchases = async () => ({ pagination: { total_results: 1 }, results: [pending] });
  siigo.invoices = async () => ({ pagination: { total_results: 1 }, results: [{
    id: "sale", date: "2026-11-18",
    items: [{ code: "ABC", quantity: 1, total: 17850, taxes: [{ id: 1, value: 2850 }] }],
  }] });
  assert.equal((await service.invoiceAnalytics({})).totals.profit, null);
  assert.equal((await service.invoiceAnalytics({ taxConfirmations: { [invoice.id]: true } })).totals.profit, 6000);
  assert.equal((await service.invoiceAnalytics({})).totals.profit, null);
  await assert.rejects(service.invoiceAnalytics(null), /Solicitud/);
});
test("historial por producto devuelve compras, evolucion y problemas sin mezclar otros codigos", async () => {
  const { service, siigo } = setup();
  const documents = [
    { ...invoice, id: "older", date: "2026-11-16", tax_included: false,
      items: [{ type: "Product", code: "ABC", quantity: 1, price: 7000 }] },
    invoice,
    { ...invoice, id: "invalid", date: "2026-11-18",
      items: [{ type: "Product", code: "ABC", quantity: 1, price: 100, taxes: [{ id: 99 }] }] },
  ];
  siigo.purchases = async () => ({ pagination: { total_results: documents.length }, results: documents });
  const history = await service.productPurchases(product.id);
  assert.equal(history.total, 2);
  assert.equal(history.rows[0].invoice_id, invoice.id);
  assert.equal(history.rows[0].unit_cost, 9000);
  assert.deepEqual(history.days.map((day) => day.cost), [7000, 9000]);
  assert.equal(history.issues.length, 1);
  assert.match(history.issues[0].reason, /no soportado/);
  await assert.rejects(service.productPurchases("missing"), /no encontrado/);
  await assert.rejects(service.productPurchases(product.id, { page: 0 }), /Pagina/);
});
test("la revalidacion antes de escribir no reutiliza una compra anterior que aun esta en vuelo", async () => {
  const { service, siigo } = setup();
  let release, reads = 0;
  siigo.purchases = async () => {
    reads++;
    if (reads === 1) return new Promise((resolve) => { release = resolve; });
    const fresh = structuredClone(invoice);
    fresh.items[0].discount = 0;
    return { pagination: { total_results: 1 }, results: [fresh] };
  };
  const pending = service.products();
  await new Promise((resolve) => setImmediate(resolve));
  const context = await service.pricingContext(product.id, undefined, true);
  assert.equal(context.product.purchase_cost, 10000);
  release({ pagination: { total_results: 1 }, results: [invoice] });
  await pending;
  assert.equal((await service.products()).items[0].purchase_cost, 10000);
  assert.equal(reads, 2);
});
test("revalidar un producto consulta su UUID y no vuelve a paginar el catalogo completo", async () => {
  const { service, siigo, calls } = setup();
  let singleReads = 0;
  siigo.product = async (id) => { assert.equal(id, product.id); singleReads++; return product; };
  const context = await service.pricingContext(product.id, {}, true);
  assert.equal(context.product.purchase_cost, 9000);
  assert.equal(singleReads, 1);
  assert.deepEqual(calls, []);
});
