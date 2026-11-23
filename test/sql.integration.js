import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import pg from "pg";
import { ACTOR_ID, INVOICE_ID, PRODUCT_ID, storedProduct } from "./fixtures.js";

const connectionString = process.env.QF_TEST_DATABASE_URL;
if (!connectionString) throw new Error("Configure QF_TEST_DATABASE_URL apuntando a una base local vacia llamada quirofano_test.");
const url = new URL(connectionString);
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/quirofano_test") {
  throw new Error("Esta prueba solo permite una base LOCAL aislada llamada quirofano_test; nunca use Supabase.");
}
const db = new pg.Client({ connectionString });
before(async () => {
  await db.connect();
  await db.query(`do $$ begin
    if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
    if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
  end $$; grant usage on schema public to anon,authenticated,service_role;`);
  const sql = await readFile(new URL("../sql/001_quirofano.sql", import.meta.url), "utf8");
  await db.query(sql);
  await db.query(sql);
});
after(async () => { await db.end(); });
const rpc = async (name, args) => (await db.query(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args)).rows[0].result;

test("migracion es repetible y RLS impide lecturas/escrituras directas desde el navegador", async () => {
  await db.query("set role authenticated");
  try {
    await assert.rejects(db.query("select * from public.quirofano_products"), /permission denied/);
    await assert.rejects(db.query("select public.quirofano_claim_price($1,$2)", [INVOICE_ID, ACTOR_ID]), /permission denied/);
  } finally { await db.query("reset role"); }
  const result = await db.query("select count(*)::int as total from pg_class where relname like 'quirofano_%' and relrowsecurity=true");
  assert.equal(result.rows[0].total, 10);
});
test("facturas se reemplazan atomicamente, sin duplicados y con consolidado y costo actualizados", async () => {
  await rpc("quirofano_sync_products", [JSON.stringify([storedProduct])]);
  await db.query("insert into quirofano_purchase_sources(id,tax_included,registered_by) values($1,true,$2)", [INVOICE_ID, ACTOR_ID]);
  const header = { date: "2026-11-17", supplier: "900", total: 18000 };
  const line = { line_number: 1, code: "ABC", description: "Prueba", quantity: 2, unit_cost: 9000,
    net_total: 18000, supplier: "900", supplier_name: "Proveedor", purchase_date: header.date };
  await rpc("quirofano_replace_purchase", [INVOICE_ID, header, JSON.stringify([line])]);
  await rpc("quirofano_replace_purchase", [INVOICE_ID, header, JSON.stringify([line])]);
  assert.equal((await db.query("select count(*)::int as n from quirofano_purchase_lines")).rows[0].n, 1);
  assert.equal(Number((await db.query("select purchase_cost from quirofano_products")).rows[0].purchase_cost), 9000);
  assert.equal(Number((await db.query("select net_total from quirofano_daily_summary")).rows[0].net_total), 18000);
  await assert.rejects(rpc("quirofano_replace_purchase", [INVOICE_ID, header, JSON.stringify([{ ...line, quantity: -1 }])]), /check constraint/);
  assert.equal((await db.query("select count(*)::int as n from quirofano_purchase_lines")).rows[0].n, 1);
  assert.equal(Number((await db.query("select quantity from quirofano_purchase_lines")).rows[0].quantity), 2);
  const moved = { ...header, date: "2026-11-16" };
  await rpc("quirofano_replace_purchase", [INVOICE_ID, moved, JSON.stringify([{ ...line, purchase_date: moved.date }])]);
  assert.equal((await db.query("select id::text from quirofano_daily_summary")).rows[0].id, "2026-11-16");
});
test("borrador y evento se crean juntos; bloqueo por producto evita aprobaciones concurrentes", async () => {
  const draft = { product_id: PRODUCT_ID, product_code: "ABC", product_name: "Prueba", list_position: 1,
    params: { cost: 9000 }, calculation: { suggested: 15000 }, fingerprint: "test", cost_source: "manual",
    cost_date: null, previous_value: 11900, proposed_value: 15000 };
  const rows = await rpc("quirofano_save_liquidations", [JSON.stringify([draft, draft]), ACTOR_ID]);
  assert.equal(rows.length, 2);
  assert.equal((await db.query("select count(*)::int as n from quirofano_price_events")).rows[0].n, 2);
  const claimed = await rpc("quirofano_claim_price", [rows[0].id, ACTOR_ID]);
  assert.equal(claimed.status, "applying");
  await assert.rejects(rpc("quirofano_claim_price", [rows[1].id, ACTOR_ID]), /QF_CONFLICT/);
  await rpc("quirofano_finish_price", [rows[0].id, ACTOR_ID, "review", "Timeout"]);
  await assert.rejects(rpc("quirofano_claim_price", [rows[1].id, ACTOR_ID]), /QF_CONFLICT/);
  await rpc("quirofano_finish_price", [rows[0].id, ACTOR_ID, "applied", null]);
  assert.equal((await rpc("quirofano_claim_price", [rows[1].id, ACTOR_ID])).status, "applying");
  await assert.rejects(rpc("quirofano_claim_price", [rows[0].id, ACTOR_ID]), /QF_STATE/);
});
test("bloqueos de sincronizacion son persistentes y solo su propietario puede liberarlos", async () => {
  assert.equal(await rpc("quirofano_acquire_sync", ["test", ACTOR_ID]), true);
  assert.equal(await rpc("quirofano_acquire_sync", ["test", INVOICE_ID]), false);
  await rpc("quirofano_release_sync", ["test", INVOICE_ID]);
  assert.equal(await rpc("quirofano_acquire_sync", ["test", INVOICE_ID]), false);
  await rpc("quirofano_release_sync", ["test", ACTOR_ID]);
  assert.equal(await rpc("quirofano_acquire_sync", ["test", INVOICE_ID]), true);
});
test("service_role puede operar los objetos protegidos sin politicas publicas", async () => {
  await db.query("set role service_role");
  try {
    assert.equal((await db.query("select count(*)::int as n from quirofano_products")).rows[0].n, 1);
    assert.equal(await rpc("quirofano_acquire_sync", ["service-test", ACTOR_ID]), true);
    await rpc("quirofano_release_sync", ["service-test", ACTOR_ID]);
  } finally { await db.query("reset role"); }
});
