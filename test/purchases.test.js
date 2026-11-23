import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeRows, bogotaDay, purchaseLines, validDate } from "../src/domain/purchases.js";
import { invoice, taxes, storedProduct } from "./fixtures.js";

test("costo neto de compra descuenta el descuento de renglon y el IVA descontable", () => {
  const [line] = purchaseLines(invoice, false, taxes);
  assert.equal(line.quantity, 2);
  assert.equal(line.unit_cost, 9000);
  assert.equal(line.net_total, 18000);
  assert.equal(line.supplier_name, "Proveedor Prueba");
});
test("la confirmacion del documento solo se usa si Siigo omite tax_included", () => {
  const doc = { ...invoice, tax_included: undefined };
  assert.equal(purchaseLines(doc, false, taxes)[0].unit_cost, 10710);
  assert.equal(purchaseLines(doc, true, taxes)[0].unit_cost, 9000);
  assert.throws(() => purchaseLines(doc, undefined, taxes), /Confirme/);
});
test("descuentos porcentuales y valores tienen tratamiento explicito", () => {
  const doc = structuredClone(invoice);
  doc.discount_type = "Percentage";
  doc.items[0].discount = 10;
  assert.equal(purchaseLines(doc, false, taxes)[0].unit_cost, 9000);
  doc.discount_type = "Value";
  doc.items[0].discount = 2380;
  assert.equal(purchaseLines(doc, false, taxes)[0].unit_cost, 9000);
});
test("Retefuente 3271 es retencion de pago y no disminuye el costo ni aumenta el IVA", () => {
  const catalog = [{ id: 3265, name: "IVA 19%", type: "IVA", percentage: 19 },
    { id: 3271, name: "Retefuente 2.5%", type: "Retefuente", percentage: 2.5 }];
  const doc = { id: "retained", date: "2026-11-03", items: [{
    type: "Product", code: "ABC", quantity: 1, price: 83026, total: 96725.29,
    taxes: [{ id: 3265, value: 15774.94 }, { id: 3271, value: 2075.65 }],
  }] };
  const [line] = purchaseLines(doc, false, catalog);
  assert.equal(line.unit_cost, 83026);
  assert.equal(line.net_total, 83026);
  assert.ok(line.warnings.some((warning) => warning.includes("3271") && warning.includes("no disminuye el costo")));
  const included = structuredClone(doc);
  included.items[0].price = 98800.94;
  assert.equal(purchaseLines(included, true, catalog)[0].unit_cost, 83026);
  assert.throws(() => purchaseLines(doc, false, catalog.filter((tax) => tax.id !== 3271)), /3271.*no soportado/);
  assert.throws(() => purchaseLines(doc, false, catalog.map((tax) => tax.id === 3271 ? { ...tax, type: "Impoconsumo" } : tax)), /no soportado/);
});
test("no mezcla activos o cuentas contables con mercancia", () => {
  const doc = structuredClone(invoice);
  doc.items.push({ type: "Account" });
  assert.equal(purchaseLines(doc, true, taxes).length, 1);
});
test("rechaza divisas, impuestos no soportados y cantidades invalidas", () => {
  assert.throws(() => purchaseLines({ ...invoice, currency: { code: "USD" } }, true, taxes), /COP/);
  assert.throws(() => purchaseLines(invoice, true, []), /Impuesto/);
  assert.throws(() => purchaseLines({ ...invoice, supplier_by_item: true }, true, taxes), /Proveedor/);
  const doc = structuredClone(invoice);
  doc.items[0].quantity = 0;
  assert.throws(() => purchaseLines(doc, true, taxes));
});
const row = (date, cost, quantity = 1, id = "a") => ({
  id: `${date}-${id}`, code: "ABC", purchase_date: date, invoice_id: id, line_number: 1,
  quantity, unit_cost: cost, net_total: cost * quantity,
});
test("compara contra ultimo dia anterior y promedio historico ponderado, sin inventar secuencia intradia", () => {
  const rows = [row("2026-11-15", 7000), row("2026-11-16", 8000, 1, "b"),
    row("2026-11-16", 10000, 3, "c"), row("2026-11-17", 12000, 2, "d")];
  const analyzed = analyzeRows(rows, [storedProduct], { target: 30, threshold: 10 });
  assert.equal(analyzed[1].previousCost, 7000);
  assert.equal(analyzed[2].previousCost, 7000);
  assert.equal(analyzed[3].previousCost, 9500);
  assert.equal(analyzed[3].historicalAverage, 9000);
  assert.equal(analyzed[3].variation, 2500);
  assert.equal(analyzed[3].variationPct, 26.32);
  assert.equal(analyzed[3].margin, -20);
  assert.equal(analyzed[3].marginImpact, -25);
  assert.ok(analyzed[3].alerts.includes("Margen bajo"));
  assert.ok(analyzed[3].alerts.includes("Aumento significativo"));
  assert.equal(analyzed[0].previousCost, null);
});
test("no estima rentabilidad con impuestos sin resolver", () => {
  const [result] = analyzeRows([row("2026-11-17", 8000)], [{ ...storedProduct, tax_error: "Revisar" }]);
  assert.equal(result.margin, null);
  assert.equal(result.suggested, null);
  assert.ok(result.alerts.includes("Sin precio comparable"));
});
test("fechas se validan y el dia operativo corresponde a Bogota", () => {
  assert.equal(bogotaDay(new Date("2026-11-18T02:00:00Z")), "2026-11-17");
  assert.equal(validDate("2024-02-29"), "2024-02-29");
  for (const date of ["2026-02-29", "2026-11-31", "17/11/2026", ""]) assert.throws(() => validDate(date));
});
