import { test } from "node:test";
import assert from "node:assert/strict";
import { calculatePrice, number, priceAt, priceFingerprint, taxProfile, updatePayload } from "../src/domain/pricing.js";
import { product, taxes } from "./fixtures.js";

const params = { cost: 7000, taxRate: 19, currentPrice: 11900, mode: "margin", target: 30, roundStep: 1, roundMode: "up" };
test("margen sobre venta neta: no confunde IVA ni incremento sobre costo", () => {
  const result = calculatePrice(params);
  assert.equal(result.suggested, 11900);
  assert.equal(result.profit, 3000);
  assert.equal(result.margin, 30);
  assert.equal(result.currentMargin, 30);
});
test("incremento sobre costo y ganancia fija son metodos distintos", () => {
  assert.equal(calculatePrice({ ...params, mode: "markup" }).suggested, 10829);
  assert.equal(calculatePrice({ ...params, mode: "fixed", target: 1000 }).suggested, 9520);
});
test("precio final fijo respeta el valor exacto con IVA y advierte perdidas sin redondear a $100", () => {
  const result = calculatePrice({ ...params, mode: "price", target: 11901, roundStep: 100 });
  assert.equal(result.suggested, 11901);
  assert.equal(result.netPrice, 10000.84);
  assert.equal(result.profit, 3000.84);
  assert.equal(result.belowCost, false);
  assert.equal(calculatePrice({ ...params, mode: "price", target: 5000 }).belowCost, true);
  assert.throws(() => calculatePrice({ ...params, mode: "price", target: 0 }));
});
test("IVA y retefuente conservan sus roles y un producto sin IVA se liquida igual", () => {
  const withRetention = { ...product, taxes: [{ id: 1 }, { id: 20 }] };
  const profile = taxProfile(withRetention, [...taxes, { id: 20, name: "Retefuente", type: "Retefuente", percentage: 2.5 }]);
  assert.equal(profile.error, null);
  assert.equal(profile.rate, 19);
  assert.equal(profile.warnings.length, 1);
  const result = calculatePrice({ ...params, taxRate: profile.rate, mode: "fixed", target: 5000, roundStep: 100 });
  assert.equal(result.suggested, 14300);
  assert.deepEqual(updatePayload(withRetention, 1, result.suggested, profile.rate).payload.taxes, [{ id: 1 }, { id: 20 }]);
  assert.equal(calculatePrice({ ...params, taxRate: 0, mode: "fixed", target: 5000, roundStep: 100 }).suggested, 12000);
});
test("costos adicionales y descuentos se aplican en orden y compensan descuento de venta", () => {
  const result = calculatePrice({ ...params, cost: 10000, costDiscount: 10, extra: 1000,
    saleDiscount: 20, target: 20, roundStep: 0.01 });
  assert.equal(result.effectiveCost, 10000);
  assert.equal(result.suggested, 18593.75);
  assert.equal(result.margin, 20);
});
test("redondear abajo informa cuando el objetivo ya no se alcanza", () => {
  const result = calculatePrice({ ...params, cost: 7100, roundStep: 1000, roundMode: "down" });
  assert.equal(result.suggested, 12000);
  assert.equal(result.belowTarget, true);
});
test("margen objetivo se cumple despues del redondeo hacia arriba", () => {
  for (const cost of [0.01, 30, 895.72, 1000, 72831]) {
    for (const target of [0, 10, 30, 75, 99]) {
      const result = calculatePrice({ ...params, cost, target, roundStep: 100 });
      assert.ok(result.margin + 0.005 >= target, `${cost}/${target} -> ${result.margin}`);
      assert.equal(result.belowTarget, false);
    }
  }
});
test("rechaza datos no numericos, infinitos, costo cero y objetivos invalidos", () => {
  for (const value of [null, undefined, "", " ", NaN, Infinity, [], {}, true]) {
    assert.throws(() => number(value, "Dato"));
  }
  for (const patch of [{ cost: 0 }, { target: 100 }, { saleDiscount: 100 }, { roundStep: 0 }, { roundMode: "inventado" }, { mode: "inventado" }]) {
    assert.throws(() => calculatePrice({ ...params, ...patch }));
  }
});
test("precio cero no inventa un margen o variacion porcentual", () => {
  const result = calculatePrice({ ...params, currentPrice: 0 });
  assert.equal(result.currentMargin, null);
  assert.equal(result.differencePct, null);
});
test("payload conserva listas, monedas y datos editables sin enviar propiedades de solo lectura", () => {
  const original = JSON.stringify(product);
  const { payload, value } = updatePayload(product, 1, 15000, 19);
  assert.equal(value, 15000);
  assert.equal(payload.account_group, 100);
  assert.equal(payload.unit, "94");
  assert.deepEqual(payload.prices[0].price_list, [{ position: 1, value: 15000 }, { position: 2, value: 11000 }]);
  assert.equal(payload.prices[1].price_list[0].value, 3);
  assert.equal(payload.id, undefined);
  assert.equal(JSON.stringify(product), original);
});
test("precio Siigo sin IVA se convierte sin modificar su politica tributaria", () => {
  const { payload, value } = updatePayload({ ...product, tax_included: false }, 1, 11900, 19);
  assert.equal(value, 10000);
  assert.equal(payload.tax_included, false);
});
test("listas ausentes e impuestos desconocidos nunca se tratan como cero", () => {
  assert.throws(() => priceAt(product, 12));
  assert.match(taxProfile(product, []).error, /No se encontro/);
  assert.equal(taxProfile(product, taxes).error, null);
  assert.match(taxProfile({ ...product, tax_consumption_value: 100 }, taxes).error, /consumo/);
  assert.match(taxProfile({ ...product, tax_included: undefined }, taxes).error, /incluye/);
  assert.match(taxProfile({ ...product, type: "Combo" }, taxes).error, /simples/);
});
test("huella detecta cambios de otras listas y no depende del orden de impuestos", () => {
  const changed = structuredClone(product);
  changed.prices[0].price_list[1].value = 12000;
  assert.notEqual(priceFingerprint(changed), priceFingerprint(product));
  assert.equal(priceFingerprint(product), priceFingerprint(structuredClone(product)));
});
