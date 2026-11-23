import { calculatePrice, DomainError, money, number, priceAt } from "./pricing.js";
import { purchaseLines, validDate } from "./purchases.js";

export function summarizeSales(rows) {
  const sold = rows.filter((row) => row.sale_error === null);
  const compared = sold.filter((row) => row.cost_error === null);
  const net = compared.reduce((sum, row) => sum + row.sale_net_total, 0);
  const cost = compared.reduce((sum, row) => sum + row.cost_total, 0);
  return {
    lines: rows.length, compared: compared.length, validSales: sold.length,
    invoices: new Set(rows.map((row) => row.invoice_id)).size,
    gross: sold.length ? money(sold.reduce((sum, row) => sum + row.sale_total, 0)) : null,
    comparableNet: compared.length ? money(net) : null,
    cost: compared.length ? money(cost) : null,
    profit: compared.length ? money(net - cost) : null,
    margin: net > 0 ? money((net - cost) / net * 100) : null,
  };
}

function salesValues(invoice, item, taxes) {
  if (invoice.currency?.code && invoice.currency.code !== "COP") throw new DomainError("Venta en divisa: no se convierte automaticamente.");
  if (!item.code) throw new DomainError("Venta sin codigo de producto.");
  const quantity = number(item.quantity, "Cantidad vendida", { min: 0.000001 });
  const gross = number(item.total, "Total final del renglon");
  let taxTotal = 0;
  for (const reference of item.taxes || []) {
    const tax = taxes.find((entry) => Number(entry.id) === Number(reference.id));
    if (!tax || tax.type !== "IVA") throw new DomainError("Tributo de venta no soportado; revisar factura.");
    taxTotal += number(reference.value, "Valor del IVA facturado");
  }
  if (taxTotal > gross) throw new DomainError("El IVA supera el total del renglon.");
  // El total facturado ya incorpora el descuento: no volver a descontarlo.
  return { quantity, sale_total: gross, sale_net_total: money(gross - taxTotal),
    final_price: money(gross / quantity), sale_net_unit: (gross - taxTotal) / quantity };
}

function dayHistory(lines) {
  const byCode = new Map();
  for (const line of lines) {
    if (!byCode.has(line.code)) byCode.set(line.code, new Map());
    const days = byCode.get(line.code);
    const day = days.get(line.purchase_date) || {
      date: line.purchase_date, quantity: 0, net: 0, raw: 0, invoices: new Set(), taxModes: new Set(), warnings: new Set(),
    };
    day.quantity += line.quantity;
    day.net += line.net_total;
    day.raw += line.raw_price * line.quantity;
    day.invoices.add(line.invoice_name);
    day.taxModes.add(line.tax_included);
    for (const warning of line.warnings) day.warnings.add(warning);
    days.set(day.date, day);
  }
  return new Map([...byCode].map(([code, days]) => [code,
    [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({
      date: day.date, quantity: day.quantity, net: day.net, cost: day.net / day.quantity,
      raw_cost: day.taxModes.size === 1 ? day.raw / day.quantity : null, invoices: [...day.invoices],
      warnings: [...day.warnings],
    })),
  ]));
}

function unresolvedReason(code, before, latest, unresolved, inclusive = false) {
  const blocked = unresolved.find((row) => row.code === code
    && (row.date < before || (inclusive && row.date === before)) && (!latest || row.date >= latest.date));
  return blocked ? `${blocked.invoice}: ${blocked.reason}` : null;
}

function purchaseHistory({ purchases, taxes, confirmations = {}, asOf, currentOnly = false, defaultTaxIncluded }) {
  validDate(asOf);
  if (!confirmations || typeof confirmations !== "object" || Array.isArray(confirmations)) {
    throw new DomainError("Las confirmaciones de IVA deben ser un objeto por factura.");
  }
  const purchaseIds = new Set(purchases.map((invoice) => invoice.id));
  for (const [id, value] of Object.entries(confirmations)) {
    if (!purchaseIds.has(id) || typeof value !== "boolean") throw new DomainError("Confirmacion de IVA no valida o factura no disponible.");
  }
  const costLines = [], unresolved = [], purchaseStatus = [];
  for (const invoice of purchases) {
    if (currentOnly && (validDate(invoice.date) > asOf || invoice.annulled || invoice.voided)) continue;
    const name = invoice.name || invoice.id;
    const included = typeof invoice.tax_included === "boolean" ? invoice.tax_included : confirmations[invoice.id] ?? defaultTaxIncluded;
    const status = { id: invoice.id, name, date: invoice.date, tax_included: included ?? null,
      from_siigo: typeof invoice.tax_included === "boolean", error: null, lines: 0, warnings: [] };
    purchaseStatus.push(status);
    try {
      validDate(invoice.date);
      if (!Array.isArray(invoice.items)) throw new DomainError("Factura sin renglones validos.");
      const count = invoice.items.filter((item) => !item.type || item.type === "Product").length;
      status.lines = count;
      if (!count) continue;
      if (invoice.date > asOf) throw new DomainError("Compra futura: no se usa como costo actual.");
      if (invoice.annulled || invoice.voided) throw new DomainError("Compra anulada: no se usa como costo.");
      if (typeof included !== "boolean") throw new DomainError("Confirme el IVA de esta compra.");
      const lines = purchaseLines(invoice, included, taxes);
      status.warnings = [...new Set(lines.flatMap((line) => line.warnings))];
      costLines.push(...lines.map((line) => ({ ...line,
        invoice_id: invoice.id, invoice_name: name, tax_included: included,
        raw_price: number(invoice.items[line.line_number - 1].price, "Valor ingresado"),
      })));
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      status.error = error.message;
      for (const item of Array.isArray(invoice.items) ? invoice.items : []) {
        if (item.code) unresolved.push({ code: item.code, date: invoice.date, invoice: name, reason: error.message });
      }
    }
  }
  return { history: dayHistory(costLines), unresolved, purchaseStatus, costLines };
}

export function productPurchaseHistory(purchases, code, taxes, asOf, confirmations = {}) {
  const data = purchaseHistory({ purchases, taxes, asOf, confirmations, currentOnly: true, defaultTaxIncluded: false });
  return {
    rows: data.costLines.filter((line) => line.code === code)
      .sort((a, b) => b.purchase_date.localeCompare(a.purchase_date) || a.invoice_id.localeCompare(b.invoice_id) || a.line_number - b.line_number),
    days: (data.history.get(code) || []).map((day) => ({
      date: day.date, cost: money(day.cost), quantity: day.quantity, invoices: day.invoices,
    })),
    issues: data.unresolved.filter((row) => row.code === code),
  };
}

export function latestPurchaseCosts(purchases, taxes, asOf, confirmations = {}) {
  const { history, unresolved } = purchaseHistory({
    purchases, taxes, asOf, confirmations, currentOnly: true, defaultTaxIncluded: false,
  });
  const codes = new Set([...history.keys(), ...unresolved.map((row) => row.code)]);
  return new Map([...codes].map((code) => {
    const latest = history.get(code)?.at(-1);
    const error = unresolvedReason(code, asOf, latest, unresolved, true);
    return [code, {
      purchase_cost: error ? null : latest?.cost ?? null,
      cost_date: error ? null : latest?.date ?? null,
      cost_error: error,
      cost_warnings: error ? [] : latest?.warnings ?? [],
    }];
  }));
}

export function buildInvoiceAnalytics({ purchases, sales, products, taxes, confirmations = {}, asOf }) {
  const { history, unresolved, purchaseStatus } = purchaseHistory({ purchases, taxes, confirmations, asOf });
  const rows = [], excluded = [];
  for (const invoice of sales) {
    validDate(invoice.date);
    if (invoice.annulled || invoice.voided || invoice.stamp?.status === "Rejected" || invoice.date > asOf) {
      excluded.push({ id: invoice.id, name: invoice.name || invoice.id, reason: "Anulada, rechazada o fecha futura." });
      continue;
    }
    if (!Array.isArray(invoice.items)) throw new DomainError("Factura de venta sin renglones validos.", 502);
    invoice.items.forEach((item, index) => {
      const row = { id: `${invoice.id}-${index}`, invoice_id: invoice.id, invoice: invoice.name || invoice.id,
        date: invoice.date, code: item.code || "", description: item.description || item.code || "Sin codigo",
        quantity: null, final_price: null, sale_total: null, sale_net_total: null, sale_net_unit: null,
        raw_cost: null, unit_cost: null, cost_total: null, profit: null, unit_profit: null, margin: null,
        cost_date: null, cost_invoices: [], sale_error: null, cost_error: null, warnings: [] };
      rows.push(row);
      try { Object.assign(row, salesValues(invoice, item, taxes)); }
      catch (error) {
        if (!(error instanceof DomainError)) throw error;
        row.sale_error = error.message;
        return;
      }
      const days = history.get(row.code) || [];
      const prior = days.filter((day) => day.date < invoice.date);
      const latest = prior.at(-1);
      const blocked = unresolvedReason(row.code, invoice.date, latest, unresolved);
      if (days.some((day) => day.date === invoice.date) || unresolved.some((entry) => entry.code === row.code && entry.date === invoice.date)) {
        row.warnings.push("Compra del mismo dia no usada: se desconoce el orden de los movimientos.");
      }
      if (blocked || !latest) {
        row.cost_error = blocked || "Sin compra confirmada anterior a la venta. No se usa un costo futuro ni del mismo dia.";
        return;
      }
      row.raw_cost = latest.raw_cost === null ? null : money(latest.raw_cost);
      if (latest.raw_cost === null) row.warnings.push("Compras con IVA incluido y excluido en el mismo dia: solo se compara su costo neto.");
      row.unit_cost = latest.cost;
      row.cost_date = latest.date;
      row.cost_invoices = latest.invoices;
      row.warnings.push(...latest.warnings);
      row.cost_total = money(latest.cost * row.quantity);
      row.profit = money(row.sale_net_total - row.cost_total);
      row.unit_profit = money(row.sale_net_unit - latest.cost);
      row.margin = row.sale_net_total > 0 ? money(row.profit / row.sale_net_total * 100) : null;
    });
    if (rows.length > 5000) throw new DomainError("La analitica supera 5.000 renglones de venta.", 422);
  }
  const candidates = products.filter((p) => p.active).map((product) => {
    const days = history.get(product.code) || [], latest = days.at(-1), previous = days.at(-2);
    const net = days.reduce((sum, day) => sum + day.net, 0);
    const quantity = days.reduce((sum, day) => sum + day.quantity, 0);
    const average = quantity > 0 ? net / quantity : null;
    const blocked = unresolvedReason(product.code, asOf, null, unresolved, true);
    const sold = rows.filter((row) => row.code === product.code && !row.sale_error);
    const soldQuantity = sold.reduce((sum, row) => sum + row.quantity, 0);
    return { id: product.id, code: product.code, name: product.name, tax_rate: product.tax_rate,
      tax_error: product.tax_error,
      payload: { tax_included: product.payload.tax_included, prices: product.payload.prices },
      latest_cost: latest?.cost ?? null, latest_date: latest?.date ?? null, average_cost: average,
      reference_cost: latest && average !== null ? Math.max(latest.cost, average) : null,
      previous_cost: previous?.cost ?? null,
      cost_change_pct: previous?.cost > 0 ? money((latest.cost - previous.cost) / previous.cost * 100) : null,
      cost_error: blocked || (!latest ? "No hay compras confirmadas para este producto." : null),
      sold_quantity: soldQuantity,
      average_sale_price: soldQuantity > 0 ? money(sold.reduce((sum, row) => sum + row.sale_total, 0) / soldQuantity) : null,
      average_sale_net_price: soldQuantity > 0 ? sold.reduce((sum, row) => sum + row.sale_net_total, 0) / soldQuantity : null,
      history: days.map((day) => ({ date: day.date, cost: money(day.cost) })) };
  });
  return { rows, purchaseInvoices: purchaseStatus, products: candidates, totals: summarizeSales(rows), excluded };
}

function invoiceSimulationContext(product, listPosition) {
  if (!product) throw new DomainError("Seleccione un producto.");
  if (product.cost_error || product.reference_cost == null) throw new DomainError(product.cost_error || "Costo sin confirmar.");
  if (!Number.isFinite(product.sold_quantity) || product.sold_quantity <= 0
    || !Number.isFinite(product.average_sale_net_price) || product.average_sale_net_price <= 0) {
    throw new DomainError("El producto no tiene ventas reales con precio neto positivo para calcular margen.");
  }
  if (product.tax_error) throw new DomainError(product.tax_error);
  const position = number(listPosition, "Lista", { min: 1, max: 12 });
  if (!Number.isInteger(position)) throw new DomainError("Lista no valida.");
  const stored = priceAt(product.payload, position);
  const rate = number(product.tax_rate, "IVA", { max: 100 });
  const currentPrice = product.payload.tax_included ? stored : money(stored * (1 + rate / 100));
  const cost = number(product.reference_cost, "Costo de referencia", { min: 0.000001 });
  return { currentPrice, cost, rate };
}

export function invoiceSimulationIssue(product, position) {
  try { invoiceSimulationContext(product, position); return null; }
  catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return error.message;
  }
}

export function simulateInvoicePrice(product, input) {
  const { currentPrice, cost, rate } = invoiceSimulationContext(product, input.position);
  const extra = number(input.extra ?? 0, "Costo adicional");
  if (!["margin", "fixed", "price"].includes(input.mode)) throw new DomainError("Objetivo de simulacion no valido.");
  const result = calculatePrice({ cost, extra, taxRate: rate, currentPrice, mode: input.mode,
    target: input.target, roundStep: input.roundStep ?? 100, roundMode: "up" });
  return { ...result, belowCost: result.profit < 0 };
}
