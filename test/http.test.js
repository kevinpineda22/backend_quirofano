import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp, cronAuthorized } from "../app.js";
import { authorize, canAccess, canEditPrices } from "../src/auth.js";

test("permisos personales reemplazan al rol y se comparan por segmento", () => {
  const role = { permissions: [{ path: "/quirofano" }] };
  assert.equal(canAccess({ personal_routes: [] }, role), true);
  assert.equal(canAccess({ personal_routes: ["/otro"] }, role), false);
  assert.equal(canAccess({ personal_routes: ["/quirofanox"] }, null), false);
  assert.equal(canAccess({ personal_routes: [] }, { redirect: "/quirofano" }), true);
  assert.equal(canAccess({ role: "admin" }, null), false);
});
test("el permiso del modulo concede edicion y conserva la prioridad de permisos personales", () => {
  const role = { permissions: ["/quirofano"] };
  assert.equal(canEditPrices({}, role), true);
  assert.equal(canEditPrices({ personal_routes: [{ path: "/quirofano" }] }, null), true);
  assert.equal(canEditPrices({ personal_routes: ["/otro"] }, role), false);
  assert.equal(canEditPrices({ personal_routes: ["/quirofanox"] }, null), false);
  assert.equal(canEditPrices({}, { redirect: "/quirofano" }), true);
  assert.equal(canEditPrices({ role: "admin" }, null), false);
});
test("cron sin secreto o con secreto incorrecto siempre se rechaza", () => {
  assert.equal(cronAuthorized(undefined, undefined), false);
  assert.equal(cronAuthorized("Bearer no", "correcto"), false);
  assert.equal(cronAuthorized("Bearer correcto", "correcto"), true);
});
test("una caida de Supabase devuelve 503, no acusa falsamente sesion invalida", async () => {
  const middleware = authorize({ auth: { getUser: async () => ({
    data: null, error: { status: 503 },
  }) } });
  let failure;
  await middleware({ headers: { authorization: "Bearer test-token" } }, {}, (error) => { failure = error; });
  assert.equal(failure.status, 503);
});
let server, base;
before(async () => {
  const app = createApp({
    service: { syncPurchases: async () => ({ results: [], hasMore: false }) },
    auth: authorize(null), cronSecret: "test-cron-secret",
  });
  await new Promise((resolve) => { server = app.listen(0, "127.0.0.1", resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); });
test("salud responde sin credenciales pero todas las rutas de negocio requieren sesion", async () => {
  assert.equal((await fetch(`${base}/api/salud`)).status, 200);
  for (const path of ["/meta", "/products", "/analysis", "/liquidations"]) {
    const response = await fetch(`${base}/api/quirofano${path}`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await response.json()).ok, false);
  }
});
test("cron esta protegido y un origen externo no recibe CORS permisivo", async () => {
  assert.equal((await fetch(`${base}/api/cron/compras`)).status, 401);
  assert.equal((await fetch(`${base}/api/cron/compras`, { headers: { Authorization: "Bearer test-cron-secret" } })).status, 200);
  const response = await fetch(`${base}/api/salud`, { headers: { Origin: "https://no-permitido.example" } });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});
test("JSON malformado y rutas inexistentes fallan explicitamente", async () => {
  const response = await fetch(`${base}/api/quirofano/liquidations`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{invalid",
  });
  assert.equal(response.status, 400);
  assert.equal((await fetch(`${base}/no-existe`)).status, 404);
});
