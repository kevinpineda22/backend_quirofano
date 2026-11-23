import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditorRepository } from "../src/editorRepository.js";
import { ACTOR_ID, PRODUCT_ID, storedProduct } from "./fixtures.js";

test("las mutaciones usan la sesion, el actor y una solicitud unica sin firma adicional", async () => {
  const calls = [];
  const db = { rpc: async (name, args) => { calls.push({ name, args }); return { data: { ok: true }, error: null }; } };
  const repo = createEditorRepository(db, ACTOR_ID);
  await repo.upsert("quirofano_products", storedProduct);
  await repo.rpc("quirofano_claim_price", { p_id: PRODUCT_ID, p_actor: ACTOR_ID });
  const envelopes = calls.map(call => JSON.parse(call.args.p_envelope));
  assert.deepEqual(envelopes.map(value => value.operation), ["snapshot", "claim"]);
  assert.ok(envelopes.every(value => value.actor === ACTOR_ID));
  assert.notEqual(envelopes[0].nonce, envelopes[1].nonce);
  for (const { name, args } of calls) {
    assert.equal(name, "quirofano_editor_command");
    assert.deepEqual(Object.keys(args), ["p_envelope"]);
  }
  assert.throws(() => repo.upsert("profiles", {}), /no permite/);
  assert.throws(() => repo.rpc("quirofano_claim_price", { p_actor: "other" }), /no autorizada/);
});
test("sin cliente de Supabase la escritura falla explicitamente", async () => {
  const repo = createEditorRepository(null, ACTOR_ID);
  assert.equal(repo.configured, false);
  await assert.rejects(repo.upsert("quirofano_products", storedProduct), /Configure Supabase/);
});
