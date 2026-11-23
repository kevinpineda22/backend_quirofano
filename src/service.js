import { randomUUID } from "node:crypto";
import { calculatePrice, DomainError, money, number, priceAt, priceFingerprint, taxProfile, updatePayload } from "./domain/pricing.js";
import { analyzeRows, bogotaDay, purchaseLines, validDate } from "./domain/purchases.js";

export function uuid(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new DomainError("El identificador debe ser un UUID valido.");
  }
  return value;
}

const integer = (value, label, min, max) => {
  const parsed = number(value, label, { min, max });
  if (!Number.isInteger(parsed)) throw new DomainError(`${label}: debe ser entero.`);
  return parsed;
};
const arrayCatalog = (data) => {
  if (!Array.isArray(data)) throw new DomainError("Catalogo de Siigo con formato no reconocido.", 502);
  return data;
};

export function quote(product, input, position) {
  if (!product.active || product.tax_error) throw new DomainError(product.tax_error || "El producto esta inactivo.", 409);
  const stored = priceAt(product.payload, position);
  const source = input.costSource === "manual" ? "manual" : "purchase";
  if (input.costSource && !["manual", "purchase"].includes(input.costSource)) throw new DomainError("Origen de costo no valido.");
  const cost = source === "manual" ? input.cost : product.purchase_cost;
  if (cost == null) throw new DomainError(`Falta costo de ${product.code}. Vincule una compra o ingrese un costo neto manual.`);
  const currentPrice = product.payload.tax_included ? stored : money(stored * (1 + product.tax_rate / 100));
  const params = {
    mode: input.mode, target: input.target, cost: number(cost, "Costo"), extra: input.extra ?? 0,
    costDiscount: input.costDiscount ?? 0, saleDiscount: input.saleDiscount ?? 0,
    roundStep: input.roundStep ?? 100, roundMode: input.roundMode ?? "up", taxRate: Number(product.tax_rate), currentPrice,
  };
  const calculation = calculatePrice(params);
  const { value } = updatePayload(product.payload, position, calculation.suggested, product.tax_rate);
  return {
    product_id: product.id, product_code: product.code, product_name: product.name, list_position: position,
    params: { ...params, ...(input.taxConfirmations !== undefined ? { taxConfirmations: input.taxConfirmations } : {}) },
    calculation, fingerprint: priceFingerprint(product.payload), cost_source: source,
    cost_date: source === "purchase" ? product.cost_date : null,
    previous_value: stored, proposed_value: value,
  };
}

function expectedFingerprint(row) {
  const snapshot = JSON.parse(row.fingerprint);
  const list = snapshot.prices.find((g) => g.currency_code === "COP")?.price_list
    .find((p) => p.position === row.list_position);
  if (!list) throw new DomainError("La liquidacion no tiene una lista de precio valida.", 409);
  list.value = Number(row.proposed_value);
  snapshot.taxes = snapshot.taxes.map((id) => ({ id }));
  return priceFingerprint(snapshot);
}

export function productPage(rows, query = {}, { paginate = true } = {}) {
  const page = integer(query.page ?? 1, "Pagina", 1, 100000);
  const position = integer(query.position ?? 1, "Lista", 1, 12);
  const target = number(query.target ?? 30, "Margen objetivo", { max: 99.99 });
  const term = String(query.search || "").toLocaleLowerCase("es").trim().slice(0, 100);
  const filtered = rows.filter((p) => p.active
    && (!query.category || p.category === query.category)
    && (!query.supplier || p.suppliers?.some((supplier) => supplier.id === query.supplier))
    && (!term || `${p.code} ${p.name} ${p.category}`.toLocaleLowerCase("es").includes(term)))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const priced = filtered.map((p) => {
    const list = p.payload.prices?.find((g) => g.currency_code === "COP")?.price_list
      ?.find((l) => Number(l.position) === position);
    const price = list ? Number(list.value) * (p.payload.tax_included ? 1 : 1 + p.tax_rate / 100) : null;
    const saleNet = price != null && !p.tax_error ? price / (1 + p.tax_rate / 100) : null;
    const rawMargin = saleNet > 0 && p.purchase_cost != null && !p.cost_error
      ? (saleNet - p.purchase_cost) / saleNet * 100 : null;
    const margin = rawMargin === null ? null : money(rawMargin);
    return {
      id: p.id, code: p.code, name: p.name, category: p.category, tax_rate: p.tax_rate, tax_error: p.tax_error,
      purchase_cost: p.purchase_cost, cost_date: p.cost_date, synced_at: p.synced_at, price: price === null ? null : money(price),
      cost_error: p.cost_error ?? null, cost_warnings: p.cost_warnings ?? [],
      tax_warnings: p.tax_warnings ?? [], suppliers: p.suppliers ?? [],
      margin, lowMargin: margin !== null && margin < target, marginAlert: rawMargin !== null && rawMargin < 20,
    };
  });
  if (![undefined, false, true, "false", "true"].includes(query.onlyLowMargin)) throw new DomainError("Filtro de margen no valido.");
  const matching = priced.filter((p) => ![true, "true"].includes(query.onlyLowMargin) || p.marginAlert);
  return { items: paginate ? matching.slice((page - 1) * 30, page * 30) : matching,
    total: matching.length, page, pages: Math.ceil(matching.length / 30),
    alerts: { below20: priced.filter((p) => p.marginAlert).length, withoutMargin: priced.filter((p) => p.margin === null).length },
    suppliers: [...new Map(rows.flatMap((p) => p.suppliers ?? []).map((s) => [s.id, s])).values()]
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, "es")),
    categories: [...new Set(rows.map((p) => p.category).filter(Boolean))].sort() };
}

export function createService({ repo, siigo, now = () => new Date() }) {
  async function withSyncLock(operation) {
    const owner = randomUUID();
    const locked = await repo.rpc("quirofano_acquire_sync", { p_id: "siigo-sync", p_owner: owner });
    if (!locked) throw new DomainError("Hay otra sincronizacion en curso. Espere y vuelva a intentar.", 409);
    try {
      return await operation();
    } finally {
      await repo.rpc("quirofano_release_sync", { p_id: "siigo-sync", p_owner: owner });
    }
  }

  async function catalogs() {
    const [taxes, lists] = await Promise.all([siigo.taxes(), siigo.priceLists()]);
    arrayCatalog(taxes);
    arrayCatalog(lists);
    await repo.upsert("quirofano_catalogs", [
      { id: "taxes", data: taxes, synced_at: now().toISOString() },
      { id: "price_lists", data: lists, synced_at: now().toISOString() },
    ]);
    return { taxes, lists };
  }

  async function syncProducts(pageInput) {
    const page = integer(pageInput ?? 1, "Pagina", 1, 100000);
    return withSyncLock(async () => {
      const { taxes } = await catalogs();
      const data = await siigo.products(page);
      const rows = data.results.map((product) => {
        if (!product.id || !product.code || !product.name || typeof product.active !== "boolean") {
          throw new DomainError("Siigo devolvio un producto incompleto; no se guardo esta pagina.", 502);
        }
        const tax = taxProfile(product, taxes);
        return { id: product.id, code: product.code, name: product.name, category: product.account_group?.name || "",
          active: product.active, tax_rate: tax.rate, tax_error: tax.error, payload: product };
      });
      if (rows.length) await repo.rpc("quirofano_sync_products", { p_rows: rows });
      const total = data.pagination.total_results;
      if (!rows.length && (page - 1) * 50 < total) {
        throw new DomainError("La paginacion de Siigo esta incompleta. Reintente esta pagina.", 502);
      }
      return { page, count: rows.length, total, nextPage: page * 50 < total ? page + 1 : null };
    });
  }

  async function products(query = {}) {
    const rows = await repo.all("quirofano_products");
    return productPage(rows, query);
  }

  async function saveLiquidations(body, actor) {
    if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 100) {
      throw new DomainError("Seleccione entre 1 y 100 productos por liquidacion.");
    }
    const position = integer(body.position, "Lista", 1, 12);
    const catalog = await repo.one("quirofano_catalogs", "price_lists");
    if (!catalog.data.some((l) => Number(l.position) === position && l.active)) {
      throw new DomainError("Seleccione una lista activa sincronizada.", 409);
    }
    const seen = new Set();
    const rows = [];
    for (const item of body.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new DomainError("Cada producto debe ser un objeto de liquidacion.");
      uuid(item.productId);
      if (seen.has(item.productId)) throw new DomainError("La seleccion contiene productos duplicados.");
      seen.add(item.productId);
      rows.push(quote(await repo.one("quirofano_products", item.productId), item, position));
    }
    return repo.rpc("quirofano_save_liquidations", { p_rows: rows, p_actor: actor });
  }

  async function approveOne(id, actor) {
    uuid(id);
    const existing = await repo.one("quirofano_liquidations", id);
    if (existing.status === "applied") return existing;
    if (!siigo.configured || !siigo.writesEnabled) throw new DomainError("Siigo no esta configurado o sus escrituras estan deshabilitadas; el borrador sigue guardado.", 409);
    const row = await repo.rpc("quirofano_claim_price", { p_id: id, p_actor: actor });
    let writeAttempted = false;
    try {
      const fresh = await siigo.product(row.product_id);
      const tax = taxProfile(fresh, arrayCatalog(await siigo.taxes()));
      const current = await repo.one("quirofano_products", row.product_id);
      if (priceFingerprint(fresh) !== row.fingerprint || tax.error || tax.rate !== Number(row.params.taxRate)
        || (row.cost_source === "purchase" && (Number(current.purchase_cost) !== Number(row.params.cost) || current.cost_date !== row.cost_date))) {
        return repo.rpc("quirofano_finish_price", {
          p_id: id, p_actor: actor, p_status: "conflict",
          p_error: "El precio, impuesto o costo cambio desde la liquidacion. Sincronice y cree un nuevo borrador.",
        });
      }
      const { payload } = updatePayload(fresh, row.list_position, row.calculation.suggested, tax.rate);
      writeAttempted = true;
      await siigo.updateProduct(row.product_id, payload);
      const verified = await siigo.product(row.product_id);
      if (priceFingerprint(verified) !== expectedFingerprint(row)) {
        throw new DomainError("La lectura posterior no confirma todos los precios esperados. Requiere verificacion.", 409);
      }
      await repo.update("quirofano_products", row.product_id, { payload: verified, synced_at: now().toISOString() });
      return await repo.rpc("quirofano_finish_price", { p_id: id, p_actor: actor, p_status: "applied", p_error: null });
    } catch (error) {
      console.error("[quirofano:approval]", id, error.status || 500);
      return repo.rpc("quirofano_finish_price", { p_id: id, p_actor: actor,
        p_status: writeAttempted ? "review" : "conflict",
        p_error: error instanceof DomainError ? error.message : "Fallo la operacion; revise antes de intentar nuevamente." });
    }
  }

  async function approve(ids, actor) {
    if (!Array.isArray(ids) || ids.length !== 1) {
      throw new DomainError("Cada solicitud debe aprobar exactamente un borrador; procese las selecciones en secuencia.");
    }
    ids.forEach(uuid);
    const results = [];
    for (const id of ids) {
      try {
        results.push(await approveOne(id, actor));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        results.push({ id, status: "error", error: error.message });
      }
    }
    return { results };
  }

  async function verify(id, actor) {
    const row = await repo.one("quirofano_liquidations", uuid(id));
    if (row.status === "applied") return row;
    if (!["applying", "review"].includes(row.status)) throw new DomainError("Este registro no necesita verificacion.", 409);
    if (now().getTime() - Date.parse(row.approved_at) < 120000) {
      throw new DomainError("La actualizacion puede seguir en curso. Espere dos minutos antes de verificar.", 409);
    }
    const fresh = await siigo.product(row.product_id);
    const matches = priceFingerprint(fresh) === expectedFingerprint(row);
    if (matches) await repo.update("quirofano_products", row.product_id, { payload: fresh, synced_at: now().toISOString() });
    return repo.rpc("quirofano_finish_price", { p_id: id, p_actor: actor,
      p_status: matches ? "applied" : "review",
      p_error: matches ? null : "Siigo no coincide con lo aprobado. No se repitio la escritura; el producto sigue bloqueado para revision." });
  }

  async function registerPurchase(body, actor) {
    const id = uuid(body?.id);
    if (typeof body.taxIncluded !== "boolean") throw new DomainError("Confirme el tratamiento del IVA en la compra.");
    const existing = await repo.list("quirofano_purchase_sources", (q) => q.eq("id", id));
    if (existing.length) throw new DomainError("Esta factura ya esta vinculada. Use sincronizar para revisarla.", 409);
    return repo.insert("quirofano_purchase_sources", {
      id, tax_included: body.taxIncluded, registered_by: actor,
    });
  }

  async function syncPurchases() {
    return withSyncLock(async () => {
      const started = Date.now();
      const taxes = arrayCatalog(await siigo.taxes());
      const results = [];
      while (Date.now() - started <= 90000) {
        const sources = await repo.list("quirofano_purchase_sources", (q) => q.lte("next_check_at", now().toISOString())
          .order("next_check_at").order("id").limit(5));
        if (!sources.length) break;
        for (const source of sources) {
          if (Date.now() - started > 90000) break;
          try {
            const invoice = await siigo.purchase(source.id);
            if (invoice.id?.toLowerCase() !== source.id.toLowerCase()) throw new DomainError("Siigo devolvio otra factura.", 502);
            const lines = purchaseLines(invoice, source.tax_included, taxes);
            await repo.rpc("quirofano_replace_purchase", { p_id: source.id,
              p_header: { date: invoice.date, supplier: String(invoice.supplier?.identification || invoice.supplier?.id || ""),
                total: number(invoice.total, "Total factura") }, p_lines: lines });
            results.push({ id: source.id, status: "synced", lines: lines.length });
          } catch (error) {
            console.error("[quirofano:purchase]", source.id, error.status || 500);
            const message = error instanceof DomainError ? error.message : "Error al consultar o analizar la factura.";
            await repo.update("quirofano_purchase_sources", source.id, {
              checked_at: now().toISOString(), next_check_at: new Date(now().getTime() + 3600000).toISOString(), error: message,
            });
            results.push({ id: source.id, status: "error", error: message });
          }
        }
      }
      const pending = await repo.list("quirofano_purchase_sources", (q) => q.lte("next_check_at", now().toISOString()).limit(1));
      return { results, hasMore: pending.length > 0, discoveryAvailable: false };
    });
  }

  async function analysis(query = {}) {
    const from = validDate(query.from || bogotaDay(now()));
    const to = validDate(query.to || from);
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 31) throw new DomainError("Consulte un rango de hasta 32 dias.");
    const position = integer(query.position ?? 1, "Lista", 1, 12);
    const target = number(query.target ?? 30, "Margen objetivo", { max: 99.99 });
    const threshold = number(query.threshold ?? 10, "Umbral de aumento", { min: 0.01, max: 1000 });
    const [lines, catalog, sources, daily] = await Promise.all([
      repo.all("quirofano_purchase_lines", (q) => q.lte("purchase_date", to)),
      repo.all("quirofano_products"),
      repo.all("quirofano_purchase_sources"),
      repo.list("quirofano_daily_summary", (q) => q.gte("id", from).lte("id", to).order("id")),
    ]);
    const analyzed = analyzeRows(lines, catalog, { position, target, threshold });
    const search = String(query.search || "").toLocaleLowerCase("es").trim().slice(0, 100);
    const rows = analyzed.filter((r) => r.purchase_date >= from && r.purchase_date <= to
      && (!query.supplier || r.supplier === query.supplier)
      && (!search || `${r.code} ${r.description}`.toLocaleLowerCase("es").includes(search)));
    if (rows.length > 5000) throw new DomainError("El analisis supera 5.000 renglones. Reduzca el rango de fechas.", 422);
    const suppliers = [...new Map(analyzed.filter((r) => r.purchase_date >= from).map((r) => [
      r.supplier, { id: r.supplier, name: r.supplier_name || r.supplier },
    ])).values()];
    const trendMap = new Map();
    for (const row of rows) {
      const point = trendMap.get(row.purchase_date) || { date: row.purchase_date, net: 0, quantity: 0, marginSum: 0, comparableCost: 0 };
      point.net += Number(row.net_total);
      point.quantity += Number(row.quantity);
      if (row.margin !== null) {
        point.marginSum += row.margin * Number(row.net_total);
        point.comparableCost += Number(row.net_total);
      }
      trendMap.set(point.date, point);
    }
    const singleProduct = new Set(rows.map((r) => r.code)).size === 1;
    const trends = [...trendMap.values()].map((p) => ({
      date: p.date, total: money(p.net),
      unitCost: singleProduct ? money(p.net / p.quantity) : null,
      margin: p.comparableCost > 0 ? money(p.marginSum / p.comparableCost) : null,
    }));
    return { rows: rows.reverse(), sources, suppliers, daily, trends, singleProduct,
      totals: { invoices: new Set(rows.map((r) => r.invoice_id)).size, products: new Set(rows.map((r) => r.code)).size,
        net: money(rows.reduce((sum, r) => sum + Number(r.net_total), 0)), alerts: rows.filter((r) => r.alerts.length).length },
      coverage: "Solo facturas vinculadas por ID. No representa todas las compras de Siigo. Margenes estimados con precios actuales e IVA descontable.",
      from, to };
  }

  return {
    syncProducts, products, saveLiquidations, approve, verify, registerPurchase, syncPurchases, analysis,
    meta: async () => ({ siigoConfigured: siigo.configured, writesEnabled: siigo.writesEnabled,
      discoveryAvailable: false, catalogs: await repo.list("quirofano_catalogs") }),
    history: async (pageInput) => {
      const page = integer(pageInput ?? 1, "Pagina", 1, 100000);
      const rows = await repo.list("quirofano_liquidations", (q) => q.order("created_at", { ascending: false }).order("id")
        .range((page - 1) * 30, page * 30));
      return { rows: rows.slice(0, 30), page, hasMore: rows.length > 30 };
    },
    events: async (id) => repo.list("quirofano_price_events", (q) => q.eq("liquidation_id", uuid(id)).order("created_at")),
  };
}
