import { test } from "node:test";
import assert from "node:assert/strict";
import { createSiigo } from "../src/siigo.js";
import { product } from "./fixtures.js";

const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const options = { username: "test-user", accessKey: "test-key-not-real", partnerId: "TestPartner" };
test("sin credenciales falla explicitamente sin salir a la red", async () => {
  let called = false;
  const client = createSiigo({ fetchImpl: async () => { called = true; } });
  await assert.rejects(client.product(product.id), /Configure SIIGO/);
  assert.equal(called, false);
});
test("autenticacion usa Partner-Id y reutiliza token en consultas concurrentes", async () => {
  const calls = [];
  const client = createSiigo({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return response(url.endsWith("/auth") ? { access_token: "test-token", expires_in: 3600 } : product);
  } });
  await Promise.all([client.product(product.id), client.product(product.id)]);
  assert.equal(calls.filter((c) => c.url.endsWith("/auth")).length, 1);
  assert.equal(calls[0].init.headers["Partner-Id"], "TestPartner");
  assert.equal(calls[1].init.headers.Authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(calls[0].init.body), { username: "test-user", access_key: "test-key-not-real" });
});
test("respeta cien solicitudes por minuto y empieza el timeout despues de esperar el cupo", async (t) => {
  let time = 0;
  const calls = [], sleeps = [], timeouts = [];
  t.mock.method(AbortSignal, "timeout", () => { timeouts.push(time); return new AbortController().signal; });
  const client = createSiigo({ ...options, now: () => time, sleep: async (ms) => { sleeps.push(ms); time += ms; },
    fetchImpl: async (url) => {
      calls.push(time);
      return response(url.endsWith("/auth") ? { access_token: "token", expires_in: 3600 } : product);
    },
  });
  await Promise.all(Array.from({ length: 105 }, () => client.product(product.id)));
  assert.equal(calls.length, 106);
  assert.deepEqual(sleeps, [60001]);
  assert.deepEqual(timeouts, calls);
  for (const stamp of calls) assert.ok(calls.filter((time) => time > stamp - 60000 && time <= stamp).length <= 100);
});
test("lectura 429 espera y reintenta; escritura nunca se reintenta", async () => {
  let gets = 0, puts = 0, sleeps = 0;
  const client = createSiigo({ ...options, writesEnabled: true, sleep: async () => { sleeps++; },
    fetchImpl: async (url, init) => {
      if (url.endsWith("/auth")) return response({ access_token: "t", expires_in: 3600 });
      if (init.method === "PUT") { puts++; return response({}, 429); }
      gets++;
      return gets === 1 ? response({}, 429, { "retry-after": "1" }) : response(product);
    } });
  await client.product(product.id);
  assert.equal(gets, 2); assert.equal(sleeps, 1);
  await assert.rejects(client.updateProduct(product.id, {}), /429/);
  assert.equal(puts, 1);
});
test("escrituras deshabilitadas no llaman a la red", async () => {
  const client = createSiigo({ ...options, fetchImpl: async () => { throw new Error("No debe llamar"); } });
  await assert.rejects(async () => client.updateProduct(product.id, {}), /deshabilitadas/);
});
test("adaptador de compras consulta por ID y pagina sin crear compras", async () => {
  const paths = [];
  const client = createSiigo({ ...options, fetchImpl: async (url) => {
    paths.push(url);
    return response(url.endsWith("/auth") ? { access_token: "t", expires_in: 3600 }
      : url.includes("?page=") ? { results: [], pagination: { total_results: 0 } } : { id: product.id });
  } });
  await client.purchase(product.id);
  assert.equal(paths[1], `https://api.siigo.com/v1/purchases/${product.id}`);
  await client.purchases(2);
  assert.equal(paths[2], "https://api.siigo.com/v1/purchases?page=2&page_size=50");
  assert.equal(client.createPurchase, undefined);
});
test("proveedores se consultan como terceros por UUID sin crear ni actualizar clientes", async () => {
  const paths = [];
  const client = createSiigo({ ...options, fetchImpl: async (url, init) => {
    paths.push(url);
    assert.ok(["POST", "GET"].includes(init.method));
    return response(url.endsWith("/auth") ? { access_token: "t", expires_in: 3600 } : { id: product.id, name: ["Proveedor"] });
  } });
  await client.customer(product.id);
  assert.equal(paths[1], `https://api.siigo.com/v1/customers/${product.id}`);
});
test("ventas se consultan por paginas y rechazan respuestas incompletas", async () => {
  const paths = [];
  let invalid = false;
  const client = createSiigo({ ...options, fetchImpl: async (url, init) => {
    paths.push(url);
    assert.ok(["GET", "POST"].includes(init.method));
    return response(url.endsWith("/auth") ? { access_token: "t", expires_in: 3600 }
      : invalid ? {} : { results: [], pagination: { total_results: 0 } });
  } });
  await client.invoices(2);
  assert.equal(paths[1], "https://api.siigo.com/v1/invoices?page=2&page_size=50");
  invalid = true;
  await assert.rejects(client.invoices(), /contrato esperado/);
});
