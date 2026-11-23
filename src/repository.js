import { DomainError } from "./domain/pricing.js";

export function createRepository(db) {
  const ready = () => {
    if (!db) throw new DomainError("Configure Supabase y ejecute la migracion de Quirofano.", 503);
  };
  async function result(query) {
    const { data, error } = await query;
    if (error) {
      if (error.code === "42501") {
        console.error("[quirofano:db]", error.code);
        throw new DomainError("Supabase rechazo la operacion. Verifique los permisos del usuario y la migracion JWT.", 403);
      }
      if (error.code === "23505") throw new DomainError("El registro ya existe. Recargue antes de continuar.", 409);
      if (error.message.includes("QF_CONFLICT")) throw new DomainError("Otro proceso esta usando este producto o documento. Revise el historial.", 409);
      if (error.message.includes("QF_STATE")) throw new DomainError("El registro cambio de estado. Recargue antes de continuar.", 409);
      console.error("[quirofano:db]", error.code || "database_error");
      throw new DomainError("No fue posible completar la operacion en Supabase. Verifique la migracion y la configuracion.", 503);
    }
    return data;
  }
  async function all(table, configure = (query) => query) {
    ready();
    const rows = [];
    for (let offset = 0; offset < 50000; offset += 500) {
      const page = await result(configure(db.from(table).select("*")).order("id").range(offset, offset + 499));
      rows.push(...page);
      if (page.length < 500) return rows;
    }
    throw new DomainError("La consulta supera 50.000 registros. Reduzca el rango o archive el historico antes de analizar.", 422);
  }
  return {
    configured: Boolean(db),
    all,
    one: async (table, id) => {
      ready();
      const data = await result(db.from(table).select("*").eq("id", id).maybeSingle());
      if (!data) throw new DomainError("Registro no encontrado.", 404);
      return data;
    },
    list: async (table, configure = (query) => query) => {
      ready();
      return result(configure(db.from(table).select("*")));
    },
    upsert: async (table, rows, onConflict = "id") => {
      ready();
      return result(db.from(table).upsert(rows, { onConflict }).select());
    },
    insert: async (table, rows) => {
      ready();
      return result(db.from(table).insert(rows).select());
    },
    rpc: async (name, args) => {
      ready();
      return result(db.rpc(name, args));
    },
    update: async (table, id, fields) => {
      ready();
      return result(db.from(table).update(fields).eq("id", id).select().single());
    },
  };
}
