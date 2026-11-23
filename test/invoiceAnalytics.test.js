import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInvoiceAnalytics, invoiceSimulationIssue, simulateInvoicePrice, summarizeSales } from "../src/domain/invoiceAnalytics.js";
import { storedProduct, taxes } from "./fixtures.js";

const buy = (changes = {}) => ({
  id: "buy", name: "FC-1", date: "2026-11-10", tax_included: false, discount_type: "Value",
  items: [{ type: "Product", code: "ABC", quantity: 1, price: 7000, discount: 0, taxes: [{ id: 1 }] }],
  ...changes,
});
const sale = (changes = {}) => ({
  id: "sale", name: "FV-1", date: "2026-11-18",
  items: [{ code: "ABC", quantity: 1, price: 10000, total: 11900, taxes: [{ id: 1, value: 1900 }] }],
  ...changes,
});
const analyze = (changes = {}) => buildInvoiceAnalytics({
  purchases: [buy()], sales: [sale()], products: [storedProduct], taxes, asOf: "2026-11-18", ...changes,
});

test("facturacion final y ganancia se calculan sin tratar el IVA como utilidad", () => {
  const data = analyze();
  const row = data.rows[0];
  assert.equal(row.final_price, 11900);
  assert.equal(row.sale_net_total, 10000);
  assert.equal(row.raw_cost, 7000);
  assert.equal(row.unit_cost, 7000);
  assert.equal(row.profit, 3000);
  assert.equal(row.margin, 30);
  assert.equal(data.totals.profit, 3000);
});
test("confirmar IVA por factura es obligatorio; no se guarda ni se infiere costo cero", () => {
  const pending = buy();
  delete pending.tax_included;
  const data = analyze({ purchases: [pending] });
  assert.equal(data.rows[0].unit_cost, null);
  assert.equal(data.totals.profit, null);
  assert.match(data.rows[0].cost_error, /Confirme el IVA/);
  assert.equal(analyze({ purchases: [pending], confirmations: { buy: false } }).rows[0].unit_cost, 7000);
  assert.equal(analyze({ purchases: [pending], confirmations: { buy: true } }).rows[0].unit_cost, 5882.35);
  assert.equal(pending.tax_included, undefined);
  assert.throws(() => analyze({ confirmations: { buy: "false" } }), /Confirmacion/);
  assert.throws(() => analyze({ confirmations: { unknown: true } }), /Confirmacion/);
  assert.throws(() => analyze({ confirmations: null }), /objeto/);
});
test("el dato explicito de Siigo prevalece y los descuentos no se aplican dos veces a ventas", () => {
  const data = analyze({ confirmations: { buy: true },
    sales: [sale({ items: [{ code: "ABC", quantity: 1, price: 12000, discount: 2000, total: 11900, taxes: [{ id: 1, value: 1900 }] }] })] });
  assert.equal(data.rows[0].unit_cost, 7000);
  assert.equal(data.rows[0].sale_net_total, 10000);
});
test("varias compras del ultimo dia anterior se ponderan por cantidades", () => {
  const data = analyze({ purchases: [buy(),
    buy({ id: "b2", items: [{ type: "Product", code: "ABC", quantity: 3, price: 11000, taxes: [] }] })] });
  assert.equal(data.rows[0].unit_cost, 10000);
  assert.equal(data.rows[0].profit, 0);
  assert.equal(data.rows[0].cost_date, "2026-11-10");
});
test("una compra futura o del mismo dia no se usa para la rentabilidad de una venta anterior", () => {
  const sameDay = buy({ id: "b2", date: "2026-11-18", items: [{ type: "Product", code: "ABC", quantity: 1, price: 9000 }] });
  const data = analyze({ purchases: [buy(), sameDay] });
  assert.equal(data.rows[0].unit_cost, 7000);
  assert.match(data.rows[0].warnings[0], /mismo dia/);
  assert.equal(analyze({ purchases: [sameDay] }).rows[0].profit, null);
  assert.equal(analyze({ sales: [sale({ date: "2026-11-01" })] }).rows[0].profit, null);
});
test("una compra reciente pendiente bloquea el uso silencioso de un costo viejo", () => {
  const pending = buy({ id: "b2", name: "FC-2", date: "2026-11-15" });
  delete pending.tax_included;
  const data = analyze({ purchases: [buy(), pending] });
  assert.equal(data.rows[0].profit, null);
  assert.match(data.rows[0].cost_error, /FC-2/);
  assert.match(data.products[0].cost_error, /FC-2/);
  assert.throws(() => simulateInvoicePrice(data.products[0], { mode: "margin", target: 30, position: 1 }), /FC-2/);
});
test("una compra antigua pendiente no altera el ultimo costo de venta pero bloquea un promedio historico incompleto", () => {
  const pending = buy({ id: "older", name: "FC-ANT", date: "2026-11-01" });
  delete pending.tax_included;
  const data = analyze({ purchases: [pending, buy()] });
  assert.equal(data.rows[0].unit_cost, 7000);
  assert.equal(data.rows[0].profit, 3000);
  assert.match(data.products[0].cost_error, /FC-ANT/);
});
test("compras con tratamientos de IVA distintos el mismo dia solo promedian el costo neto", () => {
  const included = buy({ id: "included", tax_included: true,
    items: [{ type: "Product", code: "ABC", quantity: 1, price: 8330, taxes: [{ id: 1 }] }] });
  const data = analyze({ purchases: [buy(), included] });
  assert.equal(data.rows[0].unit_cost, 7000);
  assert.equal(data.rows[0].raw_cost, null);
  assert.ok(data.rows[0].warnings.some((warning) => warning.includes("IVA incluido y excluido")));
});
test("tendencia y referencia conservadora usan el mayor costo, no una proyeccion inventada", () => {
  const data = analyze({ purchases: [
    buy({ items: [{ type: "Product", code: "ABC", quantity: 3, price: 10000 }] }),
    buy({ id: "b2", date: "2026-11-15" }),
  ] });
  const product = data.products[0];
  assert.equal(product.latest_cost, 7000);
  assert.equal(product.average_cost, 9250);
  assert.equal(product.reference_cost, 9250);
  assert.equal(product.cost_change_pct, -30);
  assert.equal(product.sold_quantity, 1);
  const result = simulateInvoicePrice(product, { mode: "margin", target: 30, position: 1 });
  assert.ok(result.margin >= 30);
  assert.equal(result.suggested % 100, 0);
});
test("simulador soporta margen, utilidad fija y precio final exacto con IVA", () => {
  const product = analyze().products[0];
  for (const [mode, target] of [["margin", 30], ["fixed", 3000], ["price", 11900]]) {
    const result = simulateInvoicePrice(product, { mode, target, position: 1 });
    assert.equal(result.suggested, 11900);
    assert.equal(result.profit, 3000);
    assert.equal(result.margin, 30);
  }
  const exact = simulateInvoicePrice(product, { mode: "price", target: 11901, position: 1, roundStep: 1000 });
  assert.equal(exact.suggested, 11901);
  assert.equal(simulateInvoicePrice(product, { mode: "price", target: 5000, position: 1 }).belowCost, true);
  assert.throws(() => simulateInvoicePrice(product, { mode: "margin", target: 100, position: 1 }), /100%/);
  assert.throws(() => simulateInvoicePrice(product, { mode: "price", target: "", position: 1 }), /numero/);
  assert.throws(() => simulateInvoicePrice(product, { mode: "fixed", target: -1, position: 1 }), /Objetivo/);
});
test("ventas incompletas, divisas e impuestos no soportados no producen utilidad falsa", () => {
  for (const invalid of [
    sale({ currency: { code: "USD" } }),
    sale({ items: [{ code: "ABC", quantity: 1, price: 10000 }] }),
    sale({ items: [{ code: "ABC", quantity: 1, total: 11900, taxes: [{ id: 99, value: 1900 }] }] }),
  ]) {
    const data = analyze({ sales: [invalid] });
    assert.ok(data.rows[0].sale_error);
    assert.equal(data.totals.profit, null);
  }
  const data = analyze({ sales: [sale(), sale({ id: "void", annulled: true }), sale({ id: "rejected", stamp: { status: "Rejected" } })] });
  assert.equal(data.rows.length, 1);
  assert.equal(data.excluded.length, 2);
});
test("totales ponderados solo incluyen renglones con costo comparable y contemplan perdidas", () => {
  const rows = analyze({ purchases: [buy({ items: [{ type: "Product", code: "ABC", quantity: 1, price: 12000 }] })] }).rows;
  assert.equal(rows[0].profit, -2000);
  assert.equal(summarizeSales(rows).margin, -20);
  assert.equal(summarizeSales([]).profit, null);
});
test("el liquidador solo admite productos con costo, ventas netas positivas, IVA y lista validos", () => {
  const product = analyze().products[0];
  assert.equal(product.average_sale_net_price, 10000);
  assert.equal(invoiceSimulationIssue(product, 1), null);
  for (const invalid of [
    { ...product, sold_quantity: 0 },
    { ...product, average_sale_net_price: 0 },
    { ...product, average_sale_net_price: null },
    { ...product, reference_cost: null },
    { ...product, reference_cost: 0 },
    { ...product, cost_error: "IVA de compra pendiente" },
    { ...product, tax_error: "Impuesto no soportado" },
    { ...product, payload: { ...product.payload, prices: [] } },
  ]) {
    assert.ok(invoiceSimulationIssue(invalid, 1));
    assert.throws(() => simulateInvoicePrice(invalid, { position: 1, mode: "margin", target: 30 }));
  }
  assert.ok(invoiceSimulationIssue(product, 12));
  assert.ok(invoiceSimulationIssue(analyze({ sales: [] }).products[0], 1));
});
test("una compra con Retefuente permite costear y propaga la explicacion a factura y venta", () => {
  const retained = buy();
  retained.items[0].taxes.push({ id: 3271, value: 175 });
  const data = analyze({ purchases: [retained], taxes: [...taxes,
    { id: 3271, name: "Retefuente 2.5%", type: "Retefuente", percentage: 2.5 }] });
  assert.equal(data.purchaseInvoices[0].error, null);
  assert.ok(data.purchaseInvoices[0].warnings.some((warning) => warning.includes("3271")));
  assert.ok(data.rows[0].warnings.some((warning) => warning.includes("Retefuente")));
  assert.equal(data.rows[0].unit_cost, 7000);
  assert.equal(data.rows[0].profit, 3000);
  assert.equal(invoiceSimulationIssue(data.products[0], 1), null);
});
