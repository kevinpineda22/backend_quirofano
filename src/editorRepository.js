import { randomUUID } from "node:crypto";
import { DomainError } from "./domain/pricing.js";
import { createRepository } from "./repository.js";

export function createEditorRepository(db, actor, { now = () => new Date(), nonce = randomUUID } = {}) {
  const reads = createRepository(db);
  async function command(operation, data) {
    const envelope = JSON.stringify({ operation, actor, nonce: nonce(), issuedAt: now().toISOString(), data });
    return reads.rpc("quirofano_editor_command", { p_envelope: envelope });
  }
  return {
    configured: reads.configured,
    one: reads.one, all: reads.all, list: reads.list,
    upsert: (table, data) => {
      if (table === "quirofano_products") return command("snapshot", data);
      if (table === "quirofano_catalogs") return command("catalogs", data);
      throw new DomainError("El editor no permite modificar esa tabla.", 403);
    },
    update: (table, id, fields) => {
      if (table !== "quirofano_products") throw new DomainError("El editor no permite modificar esa tabla.", 403);
      return command("verified-product", { id, ...fields });
    },
    rpc: (name, args) => {
      const operations = { quirofano_save_liquidations: "prepare", quirofano_claim_price: "claim", quirofano_finish_price: "finish" };
      if (!operations[name] || args.p_actor !== actor) throw new DomainError("Operacion de auditoria no autorizada.", 403);
      return command(operations[name], args);
    },
  };
}
