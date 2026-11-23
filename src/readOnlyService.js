import { DomainError, taxProfile } from "./domain/pricing.js";
import { bogotaDay, purchaseSupplier, validDate } from "./domain/purchases.js";
import { productPage } from "./service.js";
import { buildInvoiceAnalytics, latestPurchaseCosts, productPurchaseHistory } from "./domain/invoiceAnalytics.js";

function cachedRead(load, now) {
  let value, expires = 0, pending, generation = 0;
  return {
    clear: () => { value = undefined; expires = 0; pending = undefined; generation++; },
    get: async () => {
      if (value && now() < expires) return value;
      if (!pending) {
        const current = generation;
        pending = load().then((result) => {
          if (current === generation) {
            value = result;
            expires = now() + 60000;
          }
          return result;
        }).finally(() => { if (current === generation) pending = undefined; });
      }
      return pending;
    },
  };
}

async function readAll(read, limit, label) {
  const rows = [], ids = new Set();
  let total;
  for (let page = 1; page <= limit + 1; page++) {
    const data = await read(page);
    const count = data?.pagination?.total_results;
    if (!Array.isArray(data?.results) || !Number.isInteger(count) || count < 0
      || (total !== undefined && count !== total)) {
      throw new DomainError(`El listado de ${label} cambio o tiene un formato inesperado. Actualice la consulta.`, 502);
    }
    total = count;
    if (total > limit) throw new DomainError(`La consulta supera ${limit} ${label}; requiere una consulta acotada.`, 422);
    for (const row of data.results) {
      if (!row.id || ids.has(row.id)) throw new DomainError(`Siigo devolvio ${label} sin identificador o duplicados.`, 502);
      ids.add(row.id);
      rows.push(row);
    }
    if (rows.length === total) return rows;
    if (!data.results.length || rows.length > total) break;
  }
  throw new DomainError(`Siigo devolvio una lectura incompleta de ${label}. No se presentan totales parciales.`, 502);
}

export function createReadOnlyService({ siigo, now = Date.now }) {
  const supplierReads = new Map();
  function supplierName(id) {
    if (!supplierReads.has(id)) supplierReads.set(id, cachedRead(async () => {
      const customer = await siigo.customer(id);
      const name = purchaseSupplier({ supplier: customer }).name;
      if (customer?.id !== id || typeof name !== "string" || !name.trim()) {
        throw new DomainError("Siigo devolvio un tercero sin nombre o con otro identificador.", 502);
      }
      return name.trim();
    }, now));
    return supplierReads.get(id).get();
  }
  function normalizeProduct(p, taxes, readAt) {
    if (!p.code || !p.name || typeof p.active !== "boolean") throw new DomainError("Producto de Siigo incompleto.", 502);
    const tax = taxProfile(p, taxes);
    return { id: p.id, code: p.code, name: p.name, category: p.account_group?.name || "",
      active: p.active, tax_rate: tax.rate, tax_error: tax.error, tax_warnings: tax.warnings, payload: p,
      purchase_cost: null, cost_date: null, synced_at: readAt };
  }
  const catalog = cachedRead(async () => {
    const [taxes, lists, products] = await Promise.all([
      siigo.taxes(), siigo.priceLists(), readAll((page) => siigo.products(page), 50000, "productos"),
    ]);
    if (!Array.isArray(taxes) || !Array.isArray(lists)) throw new DomainError("Catalogos de Siigo no validos.", 502);
    const readAt = new Date(now()).toISOString();
    const rows = products.map((p) => normalizeProduct(p, taxes, readAt));
    return { rows, taxes, lists, readAt };
  }, now);
  const purchases = cachedRead(async () => {
    let invoices = await readAll((page) => siigo.purchases(page), 1000, "facturas");
    const supplierIssues = [], names = new Map();
    const references = [...new Map(invoices.filter((invoice) => !purchaseSupplier(invoice).name)
      .map((invoice) => [invoice.supplier?.id || invoice.supplier?.identification || invoice.id, invoice.supplier])).values()].filter(Boolean);
    for (let offset = 0; offset < references.length; offset += 4) {
      await Promise.all(references.slice(offset, offset + 4).map(async (supplier) => {
        if (!supplier.id) {
          supplierIssues.push("Una compra no informa el nombre ni el UUID del proveedor; solo puede buscarse por el identificador disponible.");
          return;
        }
        try { names.set(supplier.id, await supplierName(supplier.id)); }
        catch (error) {
          if (!(error instanceof DomainError)) throw error;
          console.error("[quirofano:supplier]", error.status);
          supplierIssues.push(`No se pudo consultar el nombre del proveedor ${supplier.identification || supplier.id}: ${error.message}`);
        }
      }));
    }
    invoices = invoices.map((invoice) => names.has(invoice.supplier?.id)
      ? { ...invoice, supplier: { ...invoice.supplier, name: names.get(invoice.supplier.id) } } : invoice);
    const rows = [];
    for (const invoice of invoices) {
      validDate(invoice.date);
      if (!Array.isArray(invoice.items)) throw new DomainError("Factura de Siigo sin renglones validos.", 502);
      invoice.items.forEach((item, index) => {
        if (item.type !== "Product") return;
        rows.push({ id: `${invoice.id}-${index}`, invoice_id: invoice.id, invoice: invoice.name || invoice.id,
          date: invoice.date, code: item.code, description: item.description || item.code, quantity: item.quantity,
          unit_price: item.price, discount: item.discount ?? null, discount_type: invoice.discount_type || null,
          tax_included: typeof invoice.tax_included === "boolean" ? invoice.tax_included : null,
          currency: invoice.currency?.code || null,
          supplier: purchaseSupplier(invoice).id, supplier_name: purchaseSupplier(invoice).name });
      });
      if (rows.length > 5000) throw new DomainError("La consulta supera 5.000 renglones de compra; requiere filtros en Siigo.", 422);
    }
    return { rows, documents: invoices, invoices: invoices.length, supplierIssues, readAt: new Date(now()).toISOString() };
  }, now);
  const sales = cachedRead(async () => ({
    documents: await readAll((page) => siigo.invoices(page), 1000, "facturas de venta"),
    readAt: new Date(now()).toISOString(),
  }), now);
  async function meta() {
    const data = await catalog.get();
    return { readOnly: true, siigoConfigured: siigo.configured, writesEnabled: false, discoveryAvailable: true,
      catalogs: [{ id: "price_lists", data: data.lists }], readAt: data.readAt,
      summary: { products: data.rows.length, active: data.rows.filter((p) => p.active).length,
        inactive: data.rows.filter((p) => !p.active).length, priceLists: data.lists.filter((l) => l.active).length } };
  }
  async function pricingContext(id, confirmations, fresh = false) {
    let products, buys, product;
    if (fresh) {
      catalog.clear(); purchases.clear();
      const [remote, taxes, lists, currentPurchases] = await Promise.all([
        siigo.product(id), siigo.taxes(), siigo.priceLists(), purchases.get(),
      ]);
      if (remote?.id !== id || !Array.isArray(taxes) || !Array.isArray(lists)) throw new DomainError("Revalidacion de Siigo incompleta.", 502);
      products = { taxes, lists }; buys = currentPurchases;
      product = normalizeProduct(remote, taxes, new Date(now()).toISOString());
    } else {
      [products, buys] = await Promise.all([catalog.get(), purchases.get()]);
      product = products.rows.find((row) => row.id === id);
    }
    if (!product) throw new DomainError("Producto no encontrado en Siigo.", 404);
    const asOf = bogotaDay(new Date(now()));
    const cost = latestPurchaseCosts(buys.documents, products.taxes, asOf, confirmations).get(product.code);
    return {
      product: { ...product, ...(cost || {
        purchase_cost: null, cost_date: null, cost_error: "Sin compras vigentes para este producto.", cost_warnings: [],
      }) },
      taxes: products.taxes, lists: products.lists, purchases: buys.documents, asOf, readAt: buys.readAt,
    };
  }
  async function catalogueProducts(confirmations, fresh = false) {
    if (fresh) { catalog.clear(); purchases.clear(); }
    const [products, buys] = await Promise.all([catalog.get(), purchases.get()]);
    const asOf = bogotaDay(new Date(now()));
    const costs = latestPurchaseCosts(buys.documents, products.taxes, asOf, confirmations);
    const suppliersByCode = new Map(), supplierIssues = [...buys.supplierIssues];
    for (const invoice of buys.documents) {
      if (invoice.date > asOf || invoice.annulled || invoice.voided) continue;
      const supplier = purchaseSupplier(invoice);
      if (invoice.supplier_by_item || !supplier.id) {
        supplierIssues.push(`${invoice.name || invoice.id}: proveedor por producto o sin identificador; no se asigna un portafolio por suposicion.`);
        continue;
      }
      for (const item of invoice.items) {
        if (item.type && item.type !== "Product") continue;
        if (!suppliersByCode.has(item.code)) suppliersByCode.set(item.code, new Map());
        const existing = suppliersByCode.get(item.code).get(supplier.id);
        suppliersByCode.get(item.code).set(supplier.id, supplier.name || !existing ? supplier : existing);
      }
    }
    return { ...products, readAt: buys.readAt, supplierIssues,
      rows: products.rows.map((product) => ({
        ...product, suppliers: [...(suppliersByCode.get(product.code)?.values() || [])],
        ...(costs.get(product.code) || {
          purchase_cost: null, cost_date: null, cost_error: "Sin compras vigentes para este producto.", cost_warnings: [],
        }),
      })) };
  }
  return {
    meta,
    pricingContext,
    productScope: async (scope, confirmations) => {
      if (!scope || !["category", "supplier"].includes(scope.type) || typeof scope.value !== "string" || !scope.value.trim()) {
        throw new DomainError("Seleccione una categoria o un proveedor para liquidar su portafolio completo.");
      }
      const context = await catalogueProducts(confirmations, true);
      return { ...context, rows: context.rows.filter((p) => p.active && (scope.type === "category"
        ? p.category === scope.value : p.suppliers.some((s) => s.id === scope.value))) };
    },
    invalidate: () => { catalog.clear(); purchases.clear(); sales.clear(); },
    productPurchases: async (id, query = {}, confirmations) => {
      if (!query || typeof query !== "object" || Array.isArray(query)) throw new DomainError("Filtros de compras no validos.");
      const page = Number(query.page ?? 1);
      if (!Number.isInteger(page) || page < 1 || page > 100000) throw new DomainError("Pagina no valida.");
      const context = await pricingContext(id, confirmations);
      const history = productPurchaseHistory(context.purchases, context.product.code, context.taxes, context.asOf, confirmations);
      return { ...history, rows: history.rows.slice((page - 1) * 30, page * 30), total: history.rows.length,
        page, pages: Math.ceil(history.rows.length / 30), readAt: context.readAt };
    },
    invoiceAnalytics: async (body = {}) => {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError("Solicitud de analitica no valida.");
      const [products, buys, invoices] = await Promise.all([catalog.get(), purchases.get(), sales.get()]);
      return { ...buildInvoiceAnalytics({
        purchases: buys.documents, sales: invoices.documents, products: products.rows, taxes: products.taxes,
        confirmations: body.taxConfirmations === undefined ? {} : body.taxConfirmations,
        asOf: bogotaDay(new Date(now())),
      }), readAt: new Date(now()).toISOString(), sourceReadAt: {
        products: products.readAt, purchases: buys.readAt, sales: invoices.readAt,
      } };
    },
    products: async (query, confirmations) => {
      if (query !== undefined && (!query || typeof query !== "object" || Array.isArray(query))) {
        throw new DomainError("Filtros de productos no validos.");
      }
      const products = await catalogueProducts(confirmations);
      return { ...productPage(products.rows, query), readAt: products.readAt, supplierIssues: products.supplierIssues };
    },
    purchases: async (query = {}) => {
      const page = Number(query.page ?? 1);
      if (!Number.isInteger(page) || page < 1 || page > 100000) throw new DomainError("Pagina no valida.");
      const from = query.from ? validDate(query.from) : null, to = query.to ? validDate(query.to) : null;
      if (from && to && from > to) throw new DomainError("El rango de fechas no es valido.");
      const data = await purchases.get();
      const term = String(query.search || "").trim().toLocaleLowerCase("es").slice(0, 100);
      const rows = data.rows.filter((r) => (!from || r.date >= from) && (!to || r.date <= to)
        && (!query.supplier || r.supplier === query.supplier)
        && (!term || `${r.code} ${r.description} ${r.supplier_name} ${r.supplier}`.toLocaleLowerCase("es").includes(term)))
        .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
      return { items: rows.slice((page - 1) * 30, page * 30), page, pages: Math.ceil(rows.length / 30),
        total: rows.length, readAt: data.readAt, supplierIssues: data.supplierIssues,
        suppliers: [...new Map(data.rows.filter((r) => r.supplier).map((r) => [r.supplier, { id: r.supplier, name: r.supplier_name }])).values()],
        summary: { invoices: data.invoices, lines: data.rows.length,
          products: new Set(data.rows.map((r) => r.code)).size } };
    },
    refresh: async () => {
      catalog.clear();
      purchases.clear();
      sales.clear();
      supplierReads.clear();
      return meta();
    },
  };
}
