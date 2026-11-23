import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { authorize } from "../src/auth.js";

const tokens = [], tables = [];
const scoped = (token) => {
  tokens.push(token);
  return {
    auth: { getUser: async (received) => ({
      data: { user: received === "expired" ? null : { id: token } },
      error: received === "expired" ? { status: 401 } : null,
    }) },
    from: (table) => {
      tables.push(table);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: table === "profiles" ? { role: "user", personal_routes: ["editor", "allowed"].includes(token) ? ["/quirofano"] : ["/otro"] }
          : { permissions: [] }, error: null,
      }) }) }) };
    },
  };
};
let server, base;
before(async () => {
  const app = createApp({
    readOnly: true, auth: authorize(scoped), cronSecret: "test-secret",
    priceEditor: (req) => ({
      capabilities: () => ({ enabled: true, storageConfigured: Boolean(req.supabase), writesEnabled: true }),
      purchases: async () => ({ rows: [] }), history: async () => ({ rows: [] }),
      prepare: async (id, body, actor) => ({ id, target: body.target, actor }),
      previewScope: async (body) => ({ rows: [], scope: body.scope }),
      apply: async (id, actor) => ({ id, actor, status: "applied" }),
      verify: async (id, actor) => ({ id, actor, status: "review" }),
    }),
    service: { meta: async () => ({ readOnly: true }), products: async (query, confirmations) => ({ items: [], query, confirmations }),
      purchases: async () => ({ items: [] }), refresh: async () => ({ readOnly: true }),
      invoiceAnalytics: async (body) => ({ received: body.taxConfirmations }) },
  });
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
const get = (path, token) => fetch(`${base}/api/quirofano${path}`, {
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

test("anon mas sesion exige token valido y permiso de modulo, con cliente por token", async () => {
  assert.equal((await get("/meta")).status, 401);
  assert.equal((await get("/meta", "expired")).status, 401);
  assert.equal((await get("/meta", "denied")).status, 403);
  const responses = await Promise.all([get("/products", "allowed"), get("/purchases", "allowed")]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.ok(tokens.includes("allowed") && tokens.includes("denied"));
  assert.ok(tables.every((table) => ["profiles", "role_permissions"].includes(table)));
});
test("modo consulta bloquea todas las escrituras y el historial incluso con sesion autorizada", async () => {
  for (const path of ["/liquidations", "/liquidations/approve", "/purchases/sources", "/sync/products", "/sync/purchases", "/liquidations/test/verify"]) {
    const response = await fetch(`${base}/api/quirofano${path}`, {
      method: "POST", headers: { Authorization: "Bearer allowed", "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(response.status, 403, path);
    assert.match((await response.json()).error, /solo consulta/);
  }
  assert.equal((await get("/liquidations", "allowed")).status, 403);
  assert.equal((await get("/analysis", "allowed")).status, 403);
  assert.equal((await fetch(`${base}/api/cron/compras`, { headers: { Authorization: "Bearer test-secret" } })).status, 403);
});
test("actualizar solo consulta requiere sesion y no llama sincronizaciones persistentes", async () => {
  const path = `${base}/api/quirofano/refresh`;
  assert.equal((await fetch(path, { method: "POST" })).status, 401);
  const response = await fetch(path, { method: "POST", headers: { Authorization: "Bearer allowed" } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.readOnly, true);
});
test("calculo de analitica con POST exige sesion y acepta confirmaciones sin persistirlas", async () => {
  const path = `${base}/api/quirofano/invoice-analytics`;
  assert.equal((await fetch(path, { method: "POST" })).status, 401);
  const response = await fetch(path, { method: "POST",
    headers: { Authorization: "Bearer allowed", "Content-Type": "application/json" },
    body: JSON.stringify({ taxConfirmations: { invoice: false } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.received, { invoice: false });
});
test("consulta de productos con confirmaciones exige sesion y permiso y conserva los filtros", async () => {
  const path = `${base}/api/quirofano/products`;
  const body = { query: { position: 2, search: "ABC" }, taxConfirmations: { invoice: true } };
  const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  assert.equal((await fetch(path, options)).status, 401);
  assert.equal((await fetch(path, { ...options, headers: { ...options.headers, Authorization: "Bearer denied" } })).status, 403);
  const response = await fetch(path, { ...options, headers: { ...options.headers, Authorization: "Bearer allowed" } });
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.deepEqual(data.query, body.query);
  assert.deepEqual(data.confirmations, body.taxConfirmations);
});
test("el permiso del modulo permite preparar, aplicar y verificar sin permiso adicional", async () => {
  const readerMeta = (await (await get("/meta", "allowed")).json()).data;
  assert.equal(readerMeta.canEditPrices, true);
  const editorMeta = (await (await get("/meta", "editor")).json()).data;
  assert.equal(editorMeta.canEditPrices, true);
  const refreshed = await fetch(`${base}/api/quirofano/refresh`, { method: "POST", headers: { Authorization: "Bearer editor" } });
  const refreshedMeta = (await refreshed.json()).data;
  assert.equal(refreshedMeta.canEditPrices, true);
  assert.equal(refreshedMeta.priceEditing.enabled, true);
  assert.equal(refreshedMeta.priceEditing.storageConfigured, true);
  for (const path of ["/products/test/price-preview", "/price-changes/test/apply", "/price-changes/test/verify"]) {
    const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: 30 }) };
    assert.equal((await fetch(`${base}/api/quirofano${path}`, options)).status, 401);
    const denied = await fetch(`${base}/api/quirofano${path}`, { ...options, headers: { ...options.headers, Authorization: "Bearer denied" } });
    assert.equal(denied.status, 403);
    for (const token of ["allowed", "editor"]) {
      const response = await fetch(`${base}/api/quirofano${path}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).data.actor, token);
    }
  }
  assert.equal((await get("/products/test/price-history", "allowed")).status, 200);
});
test("la vista previa de portafolio exige sesion y permiso del modulo", async () => {
  const url = `${base}/api/quirofano/price-scope/preview`;
  const options = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope: { type: "supplier", value: "900" } }) };
  assert.equal((await fetch(url, options)).status, 401);
  assert.equal((await fetch(url, { ...options, headers: { ...options.headers, Authorization: "Bearer denied" } })).status, 403);
  const response = await fetch(url, { ...options, headers: { ...options.headers, Authorization: "Bearer allowed" } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.scope, { type: "supplier", value: "900" });
});
