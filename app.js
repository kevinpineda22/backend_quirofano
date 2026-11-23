import "dotenv/config";
import process from "node:process";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";
import { authorize } from "./src/auth.js";
import { DomainError } from "./src/domain/pricing.js";
import { createRepository } from "./src/repository.js";
import { createService } from "./src/service.js";
import { createSiigo } from "./src/siigo.js";
import { createReadOnlyService } from "./src/readOnlyService.js";
import { createPriceEditor } from "./src/priceEditor.js";
import { createEditorRepository } from "./src/editorRepository.js";

export function cronAuthorized(header, secret) {
  if (!secret || typeof header !== "string") return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(header);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function createApp({ service, auth, cronSecret, readOnly = false, priceEditor, origins = [
  "http://localhost:5173", "http://127.0.0.1:5173", "https://merkahorro.com",
] }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || origins.includes(origin)) }));
  app.use(express.json({ limit: "128kb" }));
  app.use((_req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  const handle = (action) => async (req, res, next) => {
    try { res.json({ ok: true, data: await action(req) }); }
    catch (error) { next(error); }
  };
  const requirePricePermission = (req, _res, next) => next(req.canEditPrices === true ? undefined
    : new DomainError("Requiere acceso al modulo /quirofano.", 403));
  const editorFor = (req) => typeof priceEditor === "function" ? priceEditor(req) : priceEditor;
  const withCapabilities = (data, req) => ({
    ...data, canEditPrices: req.canEditPrices === true,
    ...(priceEditor ? { priceEditing: editorFor(req).capabilities() } : {}),
  });
  app.get("/api/salud", (_req, res) => res.json({ ok: true, service: "quirofano" }));
  app.get("/api/cron/compras", (req, res, next) => {
    if (!cronAuthorized(req.headers.authorization, cronSecret)) return res.status(401).json({ ok: false, error: "Cron no autorizado." });
    return next();
  }, handle(() => {
    if (readOnly) throw new DomainError("El cron no esta disponible en modo solo consulta.", 403);
    return service.syncPurchases();
  }));
  app.use("/api/quirofano", auth);
  if (priceEditor) {
    app.post("/api/quirofano/price-scope/preview", requirePricePermission,
      handle((req) => editorFor(req).previewScope(req.body)));
    app.post("/api/quirofano/products/:id/purchases", handle((req) => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new DomainError("Solicitud de compras no valida.");
      }
      return editorFor(req).purchases(req.params.id, req.body.query, req.body.taxConfirmations);
    }));
    app.get("/api/quirofano/products/:id/price-history", handle((req) => editorFor(req).history(req.params.id, req.query)));
    app.post("/api/quirofano/products/:id/price-preview", requirePricePermission,
      handle((req) => editorFor(req).prepare(req.params.id, req.body, req.userId)));
    app.post("/api/quirofano/price-changes/:id/apply", requirePricePermission,
      handle((req) => editorFor(req).apply(req.params.id, req.userId)));
    app.post("/api/quirofano/price-changes/:id/verify", requirePricePermission,
      handle((req) => editorFor(req).verify(req.params.id, req.userId)));
  }
  if (readOnly) {
    app.use("/api/quirofano", (req, _res, next) => {
      const allowed = (req.method === "GET" && ["/meta", "/products", "/purchases"].includes(req.path))
        || (req.method === "POST" && ["/refresh", "/invoice-analytics", "/products"].includes(req.path));
      next(allowed ? undefined : new DomainError("Modo solo consulta: no hay persistencia, historial ni aprobaciones disponibles.", 403));
    });
    app.get("/api/quirofano/purchases", handle((req) => service.purchases(req.query)));
    app.post("/api/quirofano/refresh", handle(async (req) => withCapabilities(await service.refresh(), req)));
    app.post("/api/quirofano/invoice-analytics", handle((req) => service.invoiceAnalytics(req.body)));
    app.post("/api/quirofano/products", handle((req) => {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new DomainError("Solicitud de productos no valida.");
      }
      return service.products(req.body.query, req.body.taxConfirmations);
    }));
  }
  app.get("/api/quirofano/meta", handle(async (req) => withCapabilities(await service.meta(), req)));
  app.get("/api/quirofano/products", handle((req) => service.products(req.query)));
  app.post("/api/quirofano/sync/products", handle((req) => service.syncProducts(req.body.page)));
  app.post("/api/quirofano/liquidations", requirePricePermission, handle((req) => service.saveLiquidations(req.body, req.userId)));
  app.get("/api/quirofano/liquidations", handle((req) => service.history(req.query.page)));
  app.post("/api/quirofano/liquidations/approve", requirePricePermission, handle((req) => service.approve(req.body.ids, req.userId)));
  app.post("/api/quirofano/liquidations/:id/verify", requirePricePermission, handle((req) => service.verify(req.params.id, req.userId)));
  app.get("/api/quirofano/liquidations/:id/events", handle((req) => service.events(req.params.id)));
  app.post("/api/quirofano/purchases/sources", handle((req) => service.registerPurchase(req.body, req.userId)));
  app.post("/api/quirofano/sync/purchases", handle(() => service.syncPurchases()));
  app.get("/api/quirofano/analysis", handle((req) => service.analysis(req.query)));
  app.use((_req, res) => res.status(404).json({ ok: false, error: "Ruta no encontrada." }));
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400) {
      return res.status(400).json({ ok: false, error: "JSON no valido." });
    }
    if (error.type === "entity.too.large") return res.status(413).json({ ok: false, error: "Solicitud demasiado grande." });
    const known = error instanceof DomainError;
    console.error("[quirofano:http]", known ? error.status : 500);
    return res.status(known ? error.status : 500).json({
      ok: false, error: known ? error.message : "Error interno de Quirofano. Revise los registros del backend.",
    });
  });
  return app;
}

const readOnly = process.env.QUIROFANO_READ_ONLY === "true";
const priceEditing = process.env.QUIROFANO_PRICE_EDITING_ENABLED === "true";
const supabase = (key, token) => process.env.SUPABASE_URL && key
  ? createClient(process.env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      fetch: (input, init) => fetch(input, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      }),
    },
  }) : null;
const db = readOnly ? null : supabase(process.env.SUPABASE_SERVICE_ROLE_KEY);
const siigo = createSiigo({
  username: process.env.SIIGO_USERNAME, accessKey: process.env.SIIGO_ACCESS_KEY,
  partnerId: process.env.SIIGO_PARTNER_ID, writesEnabled: (!readOnly || priceEditing) && process.env.SIIGO_WRITES_ENABLED === "true",
});
const reader = createReadOnlyService({ siigo });
const repo = createRepository(db);
const service = readOnly ? reader : createService({ repo, siigo });
export default createApp({
  service, readOnly,
  ...(readOnly ? { priceEditor: (req) => createPriceEditor({
    reader, siigo, enabled: priceEditing,
    repo: createEditorRepository(req.supabase, req.userId),
  }) } : {}),
  auth: authorize(readOnly ? (token) => supabase(process.env.SUPABASE_ANON_KEY, token) : db),
  cronSecret: process.env.CRON_SECRET,
  ...(process.env.QUIROFANO_ALLOWED_ORIGINS ? {
    origins: process.env.QUIROFANO_ALLOWED_ORIGINS.split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  } : {}),
});
