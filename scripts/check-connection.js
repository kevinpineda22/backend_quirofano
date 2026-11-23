import "dotenv/config";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createSiigo } from "../src/siigo.js";
import { createReadOnlyService } from "../src/readOnlyService.js";

const tables = [
  "products", "catalogs", "liquidations", "price_events", "product_locks",
  "purchase_sources", "purchase_invoices", "purchase_lines", "daily_summary", "sync_locks",
];

export async function checkConnection({ db, siigo, report = console.log }) {
  for (const suffix of tables) {
    const table = `quirofano_${suffix}`;
    const { error } = await db.from(table).select("id").limit(1);
    if (error) {
      throw new Error(`Supabase: no se pudo consultar ${table} (${error.code || "database_error"}). Revise las claves y ejecute sql/001_quirofano.sql.`);
    }
    report(`OK Supabase: ${table}`);
  }
  for (const [label, read] of [
    ["impuestos", () => siigo.taxes()],
    ["listas de precios", () => siigo.priceLists()],
  ]) {
    const data = await read();
    if (!Array.isArray(data)) throw new Error(`Siigo: formato no reconocido en ${label}.`);
    report(`OK Siigo: ${label} (${data.length})`);
  }
  const products = await siigo.products(1);
  report(`OK Siigo: primera pagina de productos (${products.results.length}); total ${products.pagination.total_results}`);
  report("Conexion de lectura validada. No se guardaron datos ni se modifico Siigo. Falta validar la sesion y el permiso /quirofano desde la intranet.");
}

async function main() {
  const readOnly = process.env.QUIROFANO_READ_ONLY === "true";
  const required = ["SUPABASE_URL", readOnly ? "SUPABASE_ANON_KEY" : "SUPABASE_SERVICE_ROLE_KEY",
    "SIIGO_USERNAME", "SIIGO_ACCESS_KEY", "SIIGO_PARTNER_ID"];
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (missing.length) throw new Error(`Complete el .env del backend: ${missing.join(", ")}.`);
  const siigo = createSiigo({
    username: process.env.SIIGO_USERNAME, accessKey: process.env.SIIGO_ACCESS_KEY,
    partnerId: process.env.SIIGO_PARTNER_ID, writesEnabled: false,
  });
  if (readOnly) {
    const service = createReadOnlyService({ siigo });
    const meta = await service.meta();
    const purchases = await service.purchases();
    console.log(`OK Siigo: productos=${meta.summary.products}, activos=${meta.summary.active}, inactivos=${meta.summary.inactive}.`);
    console.log(`OK Siigo: facturas=${purchases.summary.invoices}, renglones=${purchases.summary.lines}, codigos=${purchases.summary.products}.`);
    console.log("Solo lectura, sin persistencia. La sesion y el permiso /quirofano deben verificarse desde el frontend; no se consultaron tablas de Quirofano.");
    return;
  }
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) },
  });
  await checkConnection({ db, siigo });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Los errores inesperados de red no deben volcar configuracion privada.
    const safe = error instanceof Error && /^(Complete el \.env|Supabase:|Siigo |Siigo:)/.test(error.message);
    console.error(safe ? error.message : "Fallo la comprobacion de conexion. Revise las URL, la red y la configuracion del backend.");
    process.exitCode = 1;
  });
}
