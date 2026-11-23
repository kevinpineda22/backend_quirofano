export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function number(value, label, { min = 0, max = 1e12 } = {}) {
  if (!["number", "string"].includes(typeof value) || (typeof value === "string" && !value.trim())) {
    throw new DomainError(`${label}: ingrese un numero.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new DomainError(`${label}: debe estar entre ${min} y ${max}.`);
  }
  return parsed;
}

export const money = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculatePrice(input) {
  const cost = number(input.cost, "Costo neto");
  if (cost === 0) throw new DomainError("El costo debe ser mayor que cero.");
  const extra = number(input.extra ?? 0, "Costo adicional");
  const costDiscount = number(input.costDiscount ?? 0, "Descuento de compra", { max: 99.99 });
  const saleDiscount = number(input.saleDiscount ?? 0, "Descuento de venta", { max: 99.99 });
  const taxRate = number(input.taxRate, "Impuesto", { max: 100 });
  const currentPrice = number(input.currentPrice, "Precio actual");
  const target = number(input.target, "Objetivo", {
    min: input.mode === "price" ? 0.01 : 0,
    max: input.mode === "price" ? 1e12 : input.mode === "fixed" ? 1e10 : 1000,
  });
  const effectiveCost = cost * (1 - costDiscount / 100) + extra;
  let net;
  if (input.mode === "margin") {
    if (target >= 100) throw new DomainError("El margen sobre venta debe ser menor al 100%.");
    net = effectiveCost / (1 - target / 100);
  } else if (input.mode === "markup") {
    net = effectiveCost * (1 + target / 100);
  } else if (input.mode === "fixed") {
    net = effectiveCost + target;
  } else if (input.mode === "price") {
    net = target * (1 - saleDiscount / 100) / (1 + taxRate / 100);
  } else {
    throw new DomainError("Metodo de liquidacion no valido.");
  }
  const step = number(input.roundStep ?? 1, "Multiplo de redondeo", { min: 0.01, max: 100000 });
  const roundMode = input.roundMode ?? "up";
  const rounding = { up: Math.ceil, nearest: Math.round, down: Math.floor }[roundMode];
  if (!rounding) throw new DomainError("Redondeo no valido.");
  const raw = net * (1 + taxRate / 100) / (1 - saleDiscount / 100);
  const suggested = input.mode === "price" ? money(target)
    : money(rounding(raw / step - (roundMode === "up" ? 1e-10 : 0)) * step);
  if (suggested <= 0 || !Number.isFinite(suggested) || suggested > 1e12) {
    throw new DomainError("El precio calculado esta fuera de rango.");
  }
  const saleNet = suggested * (1 - saleDiscount / 100) / (1 + taxRate / 100);
  const profit = saleNet - effectiveCost;
  const currentNet = currentPrice * (1 - saleDiscount / 100) / (1 + taxRate / 100);
  return {
    effectiveCost: money(effectiveCost), suggested, netPrice: money(saleNet),
    profit: money(profit), margin: money(profit / saleNet * 100),
    currentMargin: currentNet > 0 ? money((currentNet - effectiveCost) / currentNet * 100) : null,
    difference: money(suggested - currentPrice),
    differencePct: currentPrice > 0 ? money((suggested - currentPrice) / currentPrice * 100) : null,
    belowTarget: saleNet + 0.005 < net, belowCost: profit < 0,
  };
}

export function priceAt(product, position) {
  const group = product.prices?.find((p) => p.currency_code === "COP");
  const price = group?.price_list?.find((p) => Number(p.position) === Number(position));
  if (!price) throw new DomainError("El producto no tiene esa lista de precios en COP.", 409);
  return number(price.value, "Precio Siigo");
}

export function taxProfile(product, catalog = []) {
  const failures = [];
  const warnings = [];
  let rate = 0;
  if (typeof product.tax_included !== "boolean") failures.push("Siigo no informa si el precio incluye IVA.");
  if (Number(product.tax_consumption_value || 0) !== 0) failures.push("Impuesto al consumo fijo: requiere revision tributaria.");
  for (const reference of product.taxes || []) {
    const tax = catalog.find((t) => Number(t.id) === Number(reference.id));
    if (!tax) {
      failures.push(`No se encontro el impuesto ${reference.id} en el catalogo.`);
    } else if (tax.type === "Retefuente") {
      number(tax.percentage, "Porcentaje de Retefuente", { max: 100 });
      warnings.push(`${tax.name || "Retefuente"}: retencion de pago; no se suma al IVA ni reduce la ganancia calculada.`);
    } else if (tax.type !== "IVA") {
      failures.push(`Impuesto ${tax.name || tax.type} no soportado por el liquidador.`);
    } else {
      rate += number(tax.percentage, "Porcentaje IVA", { max: 100 });
    }
    if (product.tax_classification === "Taxed" && !(product.taxes || []).length) failures.push("Producto gravado sin impuesto definido.");
  }
  if (product.type !== "Product" && product.type !== "Service") failures.push("Solo se liquidan productos y servicios simples.");
  return { rate, error: failures.length ? failures.join(" ") : null, warnings };
}

export function updatePayload(product, position, grossPrice, rate) {
  const value = product.tax_included ? grossPrice : money(grossPrice / (1 + rate / 100));
  const payload = {};
  for (const key of ["code", "name", "type", "stock_control", "active", "tax_classification",
    "tax_included", "tax_consumption_value", "unit_label", "reference", "description",
    "barcode", "brand", "tariff", "model"]) {
    if (product[key] !== undefined) payload[key] = product[key];
  }
  payload.account_group = number(product.account_group?.id, "Grupo de inventario", { min: 1 });
  if (product.unit?.code) payload.unit = product.unit.code;
  payload.taxes = (product.taxes || []).map(({ id }) => ({ id }));
  payload.prices = (product.prices || []).map((group) => ({
    currency_code: group.currency_code,
    price_list: group.price_list.map((p) => ({
      position: Number(p.position),
      value: group.currency_code === "COP" && Number(p.position) === Number(position) ? value : number(p.value, "Precio"),
    })),
  }));
  priceAt(product, position);
  return { payload, value };
}

export function priceFingerprint(product) {
  return JSON.stringify({
    code: product.code, active: product.active, type: product.type,
    tax_included: product.tax_included, tax_consumption_value: product.tax_consumption_value || 0,
    taxes: (product.taxes || []).map((t) => Number(t.id)).sort((a, b) => a - b),
    prices: (product.prices || []).map((g) => ({
      currency_code: g.currency_code,
      price_list: g.price_list.map((p) => ({ position: Number(p.position), value: Number(p.value) }))
        .sort((a, b) => a.position - b.position),
    })).sort((a, b) => a.currency_code.localeCompare(b.currency_code)),
  });
}
