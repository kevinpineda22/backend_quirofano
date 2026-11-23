import { DomainError, number, priceFingerprint } from "./domain/pricing.js";
import { createService, productPage, quote, uuid } from "./service.js";

export function createPriceEditor({ reader, repo, siigo, enabled = false, now = () => new Date() }) {
  const persistent = createService({ repo, siigo, now });
  function ready() {
    if (!enabled) throw new DomainError("La edicion de precios esta deshabilitada en el backend.", 403);
    if (!repo.configured) throw new DomainError("Configure SUPABASE_URL y SUPABASE_ANON_KEY en el backend para guardar la auditoria con la sesion.", 503);
  }
  function input(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError("Liquidacion no valida.");
    const mode = body.mode ?? "margin";
    if (!["margin", "fixed", "price"].includes(mode)) throw new DomainError("Metodo de liquidacion no valido.");
    const target = number(body.target, mode === "margin" ? "Margen objetivo" : mode === "fixed" ? "Ganancia fija" : "Precio final fijo",
      { min: mode === "price" ? 0.01 : 0, max: mode === "margin" ? 99.99 : mode === "fixed" ? 1e10 : 1e12 });
    return { mode, target, roundStep: 100, roundMode: "up", taxConfirmations: body.taxConfirmations };
  }
  async function refreshProduct(id, confirmations, expected) {
    const context = await reader.pricingContext(uuid(id), confirmations, true);
    const { product } = context;
    if (!product.active || product.tax_error || product.cost_error || product.purchase_cost == null) {
      throw new DomainError(product.tax_error || product.cost_error || "El producto no tiene costo o esta inactivo.", 409);
    }
    if (expected !== undefined && (!expected || typeof expected !== "object" || Array.isArray(expected)
      || expected.fingerprint !== priceFingerprint(product.payload) || Number(expected.cost) !== Number(product.purchase_cost)
      || expected.costDate !== product.cost_date || Number(expected.taxRate) !== Number(product.tax_rate))) {
      throw new DomainError("El costo, precio o IVA cambio desde la vista previa del portafolio. Revise nuevamente antes de aplicar.", 409);
    }
    await repo.upsert("quirofano_products", {
      id: product.id, code: product.code, name: product.name, category: product.category,
      active: product.active, tax_rate: product.tax_rate, tax_error: product.tax_error,
      purchase_cost: product.purchase_cost, cost_date: product.cost_date, payload: product.payload,
      synced_at: now().toISOString(),
    });
    await repo.upsert("quirofano_catalogs", [
      { id: "taxes", data: context.taxes, synced_at: now().toISOString() },
      { id: "price_lists", data: context.lists, synced_at: now().toISOString() },
    ]);
    return context;
  }
  return {
    capabilities: () => ({ enabled, storageConfigured: repo.configured, writesEnabled: siigo.writesEnabled }),
    purchases: (id, query, confirmations) => reader.productPurchases(uuid(id), query, confirmations),
    previewScope: async (body) => {
      ready();
      const settings = input(body);
      const position = number(body.position, "Lista", { min: 1, max: 12 });
      if (!Number.isInteger(position)) throw new DomainError("La lista debe ser entera.");
      const context = await reader.productScope(body.scope, body.taxConfirmations);
      if (!context.lists.some((list) => Number(list.position) === position && list.active)) throw new DomainError("Seleccione una lista activa.", 409);
      if (!context.rows.length) throw new DomainError("No hay productos activos en este portafolio.", 404);
      const publicProducts = new Map(productPage(context.rows, { position }, { paginate: false }).items.map((p) => [p.id, p]));
      const rows = context.rows.map((product) => {
        try {
          uuid(product.id);
          if (product.cost_error) throw new DomainError(product.cost_error, 409);
          const proposal = quote(product, { ...settings, costSource: "purchase" }, position);
          return { product: publicProducts.get(product.id), params: proposal.params, calculation: proposal.calculation,
            expected: { fingerprint: proposal.fingerprint, cost: proposal.params.cost, costDate: proposal.cost_date, taxRate: proposal.params.taxRate }, error: null };
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return { product: publicProducts.get(product.id), error: error.message };
        }
      });
      return { rows, total: rows.length, eligible: rows.filter((row) => !row.error).length,
        scope: body.scope, position, readAt: context.readAt, supplierIssues: context.supplierIssues };
    },
    prepare: async (id, body, actor) => {
      ready();
      const settings = input(body);
      await refreshProduct(id, body.taxConfirmations, body.expected);
      const rows = await persistent.saveLiquidations({ position: body.position, items: [{
        productId: id, costSource: "purchase", ...settings,
      }] }, actor);
      return rows[0];
    },
    apply: async (id, actor) => {
      ready();
      if (!siigo.writesEnabled) throw new DomainError("Las escrituras en Siigo estan deshabilitadas. Habilite SIIGO_WRITES_ENABLED para aplicar el precio.", 403);
      const row = await repo.one("quirofano_liquidations", uuid(id));
      if (row.status === "applied") return row;
      if (row.status !== "draft") throw new DomainError("Este cambio ya fue enviado. Consulte el historial y verifique sin repetir la escritura.", 409);
      const context = await refreshProduct(row.product_id, row.params.taxConfirmations);
      if (!context.lists.some((list) => Number(list.position) === row.list_position && list.active)) {
        throw new DomainError("La lista ya no esta activa. Prepare un nuevo cambio.", 409);
      }
      const result = await persistent.approve([id], actor);
      reader.invalidate();
      return result.results[0];
    },
    verify: async (id, actor) => {
      ready();
      const saved = await repo.one("quirofano_liquidations", uuid(id));
      if (!["applying", "review"].includes(saved.status)) return saved;
      const result = await persistent.verify(uuid(id), actor);
      reader.invalidate();
      return result;
    },
    history: async (id, query = {}) => {
      if (!repo.configured) throw new DomainError("Historial de precios no disponible: configure Supabase con anon key y ejecute las migraciones 001 y 002.", 503);
      const page = number(query.page ?? 1, "Pagina", { min: 1, max: 100000 });
      if (!Number.isInteger(page)) throw new DomainError("Pagina: debe ser entera.");
      const rows = await repo.all("quirofano_liquidations", (q) => q.eq("product_id", uuid(id)));
      rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
      return { rows: rows.slice((page - 1) * 30, page * 30), total: rows.length, page,
        pages: Math.ceil(rows.length / 30), appliedCount: rows.filter((row) => row.status === "applied").length };
    },
  };
}
