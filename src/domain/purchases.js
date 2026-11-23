import { DomainError, money, number } from "./pricing.js";

export const bogotaDay = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
}).format(date);

export function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new DomainError("Fecha no valida; use AAAA-MM-DD.");
  }
  return value;
}

export function purchaseSupplier(invoice) {
  return {
    id: String(invoice.supplier?.identification || invoice.supplier?.id || ""),
    name: Array.isArray(invoice.supplier?.name) ? invoice.supplier.name.join(" ") : invoice.supplier?.name || "",
  };
}

export function purchaseLines(invoice, registeredTaxIncluded, taxes) {
  if (!invoice.id || !Array.isArray(invoice.items)) throw new DomainError("Factura Siigo incompleta.", 502);
  validDate(invoice.date);
  if (invoice.currency?.code && invoice.currency.code !== "COP") {
    throw new DomainError("La factura no esta en COP; requiere conversion contable validada.");
  }
  if (invoice.supplier_by_item) throw new DomainError("Proveedor por item: requiere revision antes de analizar.");
  const taxIncluded = typeof invoice.tax_included === "boolean" ? invoice.tax_included : registeredTaxIncluded;
  if (typeof taxIncluded !== "boolean") throw new DomainError("Confirme si la factura incluye IVA en el precio unitario.");
  return invoice.items.flatMap((item, index) => {
    if (item.type && item.type !== "Product") return [];
    if (!item.code) throw new DomainError(`Renglon ${index + 1}: falta el codigo de producto.`);
    const quantity = number(item.quantity, "Cantidad", { min: 0.000001 });
    const price = number(item.price, "Costo unitario");
    let rate = 0;
    const warnings = [];
    for (const ref of item.taxes || []) {
      const tax = taxes.find((t) => Number(t.id) === Number(ref.id));
      if (tax?.type === "Retefuente") {
        const percentage = number(tax.percentage, "Porcentaje de Retefuente", { max: 100 });
        warnings.push(`${tax.name || `Retefuente ${percentage}%`} (${tax.id}): retencion de pago; no disminuye el costo ni se suma al IVA.`);
      } else if (tax?.type === "IVA") {
        rate += number(tax.percentage, "IVA", { max: 100 });
      } else {
        throw new DomainError(`Impuesto de compra ${ref.id}${tax ? ` (${tax.name || tax.type})` : ""} no soportado; revise la factura.`);
      }
    }
    let discount = 0;
    if (item.discount && typeof item.discount === "object") {
      discount = item.discount.value != null
        ? number(item.discount.value, "Descuento")
        : price * quantity * number(item.discount.percentage ?? 0, "Descuento", { max: 100 }) / 100;
    } else if (item.discount != null && Number(item.discount) !== 0) {
      if (invoice.discount_type === "Percentage") {
        discount = price * quantity * number(item.discount, "Descuento", { max: 100 }) / 100;
      } else if (invoice.discount_type === "Value") {
        discount = number(item.discount, "Descuento");
      } else {
        throw new DomainError("Tipo de descuento de compra no reconocido.");
      }
    }
    const total = price * quantity - discount;
    if (total <= 0) throw new DomainError("Costo neto no positivo; revise descuentos y devoluciones.");
    const netTotal = total / (taxIncluded ? 1 + rate / 100 : 1);
    return [{
      line_number: index + 1, code: item.code, description: item.description || item.code,
      quantity, unit_cost: Number((netTotal / quantity).toFixed(6)), net_total: money(netTotal),
      supplier: purchaseSupplier(invoice).id,
      supplier_name: purchaseSupplier(invoice).name,
      purchase_date: invoice.date,
      warnings,
    }];
  });
}

export function analyzeRows(rows, products, { position = 1, target = 30, threshold = 10 } = {}) {
  const byCode = new Map(products.map((p) => [p.code, p]));
  const histories = new Map();
  return [...rows].sort((a, b) => a.purchase_date.localeCompare(b.purchase_date)
    || String(a.invoice_id).localeCompare(String(b.invoice_id)) || a.line_number - b.line_number).map((row) => {
    const history = histories.get(row.code) || {
      day: row.purchase_date, dayNet: 0, dayQuantity: 0, previousCost: null, priorNet: 0, priorQuantity: 0,
    };
    // Sin hora del comprobante no se inventa un orden de compras dentro del mismo dia.
    if (history.day !== row.purchase_date) {
      history.previousCost = history.dayNet / history.dayQuantity;
      history.priorNet += history.dayNet;
      history.priorQuantity += history.dayQuantity;
      history.day = row.purchase_date;
      history.dayNet = 0;
      history.dayQuantity = 0;
    }
    const previousCost = history.previousCost;
    const historicalAverage = history.priorQuantity > 0 ? history.priorNet / history.priorQuantity : null;
    const cost = Number(row.unit_cost);
    const variation = previousCost === null ? null : money(cost - previousCost);
    const variationPct = previousCost > 0 ? money((cost - previousCost) / previousCost * 100) : null;
    const product = byCode.get(row.code);
    const group = product?.payload?.prices?.find((g) => g.currency_code === "COP");
    const list = group?.price_list?.find((p) => Number(p.position) === Number(position));
    const saleNet = list && !product.tax_error
      ? Number(list.value) / (product.payload.tax_included ? 1 + product.tax_rate / 100 : 1) : null;
    const margin = saleNet > 0 ? money((saleNet - cost) / saleNet * 100) : null;
    const oldMargin = saleNet > 0 && previousCost !== null ? money((saleNet - previousCost) / saleNet * 100) : null;
    const alerts = [];
    if (variationPct >= threshold) alerts.push("Aumento significativo");
    else if (variationPct > 0) alerts.push("Aumento de costo");
    if (margin !== null && margin < target) alerts.push("Margen bajo");
    if (historicalAverage > 0 && cost >= historicalAverage * 1.5) alerts.push("Anomalia frente al promedio");
    if (!product || !list || product.tax_error) alerts.push("Sin precio comparable");
    history.dayNet += Number(row.net_total);
    history.dayQuantity += Number(row.quantity);
    histories.set(row.code, history);
    return { ...row, previousCost, historicalAverage: historicalAverage === null ? null : money(historicalAverage),
      variation, variationPct, margin, marginImpact: margin === null || oldMargin === null ? null : money(margin - oldMargin),
      alerts, product_id: product?.id || null,
      suggested: product && !product.tax_error && cost > 0
        ? Math.ceil(cost / (1 - target / 100) * (1 + product.tax_rate / 100) / 100) * 100 : null };
  });
}
