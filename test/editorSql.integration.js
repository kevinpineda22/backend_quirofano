import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { ACTOR_ID, INVOICE_ID, PRODUCT_ID, storedProduct } from "./fixtures.js";

let db, embedded = false;
if (process.env.QF_TEST_PGLITE_ROOT) {
  const root = process.env.QF_TEST_PGLITE_ROOT;
  const { PGlite } = await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
  db = new PGlite();
  embedded = true;
} else {
  if (!process.env.QF_TEST_DATABASE_URL) throw new Error("Configure una base PostgreSQL local aislada llamada quirofano_test.");
  const url = new URL(process.env.QF_TEST_DATABASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/quirofano_test") {
    throw new Error("Esta prueba nunca permite Supabase ni bases remotas.");
  }
  db = new pg.Client({ connectionString: process.env.QF_TEST_DATABASE_URL });
}
const reader = "55555555-5555-4555-8555-555555555555";
const denied = "66666666-6666-4666-8666-666666666666";
const override = "77777777-7777-4777-8777-777777777777";
const exec = (sql) => embedded ? db.exec(sql) : db.query(sql);
async function asUser(actor, action, role = "authenticated") {
  await db.query(`set role ${role}`);
  try {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [actor || ""]);
    return await action();
  } finally { await db.query("reset role"); }
}
function request(operation, data, actor = ACTOR_ID, changes = {}) {
  const envelope = JSON.stringify({ operation, data, actor, nonce: randomUUID(), issuedAt: new Date().toISOString(), ...changes });
  return [envelope];
}
const command = async (args) => (await db.query("select public.quirofano_editor_command($1) as result", args)).rows[0].result;
before(async () => {
  if (!embedded) await db.connect();
  await exec(`do $$ begin
    if not exists(select from pg_roles where rolname='anon') then create role anon; end if;
    if not exists(select from pg_roles where rolname='authenticated') then create role authenticated; end if;
    if not exists(select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
  end $$;
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  $$;
  grant usage on schema public,auth to authenticated,anon;
  create table if not exists public.profiles(user_id uuid primary key, role text, personal_routes jsonb);
  create table if not exists public.role_permissions(role text primary key, permissions jsonb, redirect text);
  insert into public.role_permissions(role,permissions) values('editor','["/quirofano"]')
    on conflict(role) do update set permissions=excluded.permissions;
  `);
  for (const [id, role, personal] of [
    [ACTOR_ID, "editor", []], [reader, null, ["/quirofano"]], [denied, null, ["/otro"]], [override, "editor", ["/otro"]],
  ]) {
    await db.query("insert into public.profiles values($1,$2,$3) on conflict(user_id) do update set role=excluded.role,personal_routes=excluded.personal_routes",
      [id, role, JSON.stringify(personal)]);
  }
  const base = await readFile(new URL("../sql/001_quirofano.sql", import.meta.url), "utf8");
  const migration = await readFile(new URL("../sql/002_editor_jwt.sql", import.meta.url), "utf8");
  await exec(base);
  await exec(`create or replace function public.quirofano_editor_command(text,text) returns jsonb
    language sql as $$ select '{}'::jsonb; $$;`);
  await exec(migration);
  await exec(migration);
  await asUser(ACTOR_ID, () => command(request("snapshot", storedProduct)));
});
after(async () => { if (embedded) await db.close(); else await db.end(); });

test("RLS permite leer solo al modulo y deniega escrituras directas incluso al editor", async () => {
  await asUser(reader, async () => {
    assert.equal((await db.query("select id from public.quirofano_products")).rows.length, 1);
    await assert.rejects(db.query("update public.quirofano_products set purchase_cost=1"), /permission denied/);
  });
  await asUser(denied, async () => {
    assert.equal((await db.query("select id from public.quirofano_products")).rows.length, 0);
  });
  await asUser(ACTOR_ID, async () => {
    await assert.rejects(db.query("update public.quirofano_products set purchase_cost=1"), /permission denied/);
    await assert.rejects(db.query("select * from public.quirofano_editor_requests"), /permission denied/);
    await assert.rejects(db.query("select public.quirofano_claim_price($1,$2)", [INVOICE_ID, ACTOR_ID]), /permission denied/);
  });
  await asUser(null, async () => {
    await assert.rejects(db.query("select * from public.quirofano_products"), /permission denied/);
    await assert.rejects(command(request("snapshot", storedProduct)), /permission denied/);
  }, "anon");
});
test("el permiso del modulo permite guardar propuesta, bloqueo e historial con el actor del JWT", async () => {
  await asUser(ACTOR_ID, async () => {
    await command(request("catalogs", [{ id: "price_lists", data: [{ position: 1, active: true }] }]));
    const rows = await command(request("prepare", { p_actor: reader, p_rows: [{
      product_id: PRODUCT_ID, product_code: "ABC", product_name: "Prueba", list_position: 1,
      params: { cost: 7000 }, calculation: { suggested: 15000 }, fingerprint: "fixture",
      cost_source: "purchase", cost_date: "2026-11-16", previous_value: 11900, proposed_value: 15000,
    }] }));
    assert.equal(rows[0].created_by, ACTOR_ID);
    const claimed = await command(request("claim", { p_id: rows[0].id }));
    assert.equal(claimed.status, "applying");
    const applied = await command(request("finish", { p_id: rows[0].id, p_actor: reader, p_status: "applied", p_error: null }));
    assert.equal(applied.status, "applied");
    assert.equal(applied.approved_by, ACTOR_ID);
    const events = (await db.query("select event,actor from public.quirofano_price_events where liquidation_id=$1 order by created_at,id", [rows[0].id])).rows;
    assert.deepEqual(events.map(row => row.event).sort(), ["applied", "approved", "created"]);
    assert.ok(events.every(row => row.actor === ACTOR_ID));
    const verified = await command(request("verified-product", { id: PRODUCT_ID, payload: storedProduct.payload }));
    assert.equal(verified.id, PRODUCT_ID);
  });
});
test("se rechazan solicitudes vacias, actor distinto y solicitudes vencidas", async () => {
  await asUser(ACTOR_ID, async () => {
    await assert.rejects(command([null]), /QF_REQUEST/);
    await assert.rejects(command(["null"]), /QF_REQUEST/);
    await assert.rejects(command(request("snapshot", storedProduct, reader)), /QF_REQUEST/);
    await assert.rejects(command(request("snapshot", storedProduct, ACTOR_ID, { issuedAt: new Date(Date.now() - 180000).toISOString() })), /QF_REQUEST/);
    assert.equal(Number((await db.query("select purchase_cost from public.quirofano_products")).rows[0].purchase_cost), 7000);
  });
});
test("el permiso personal del modulo permite editar y los permisos personales reemplazan al rol", async () => {
  await asUser(reader, async () => {
    assert.equal((await db.query("select public.quirofano_editor_access(true) as allowed")).rows[0].allowed, true);
    const product = await command(request("snapshot", storedProduct, reader));
    assert.equal(product.id, PRODUCT_ID);
  });
  for (const actor of [denied, override]) {
    await asUser(actor, async () => {
      assert.equal((await db.query("select public.quirofano_editor_access(true) as allowed")).rows[0].allowed, false);
      await assert.rejects(command(request("snapshot", storedProduct, actor)), /QF_PERMISSION/);
    });
  }
});
test("no se puede repetir un comando ni despachar una operacion fuera de la lista permitida", async () => {
  await asUser(ACTOR_ID, async () => {
    const args = request("snapshot", storedProduct);
    await command(args);
    await assert.rejects(command(args), /duplicate key/);
    await assert.rejects(command(request("delete", {})), /QF_PERMISSION/);
  });
});
test("la migracion elimina la RPC anterior con firma y no requiere configuracion secreta", async () => {
  const { rows } = await db.query("select to_regprocedure('public.quirofano_editor_command(text,text)') as old_rpc, to_regclass('public.quirofano_editor_config') as config");
  assert.equal(rows[0].old_rpc, null);
  assert.equal(rows[0].config, null);
});
