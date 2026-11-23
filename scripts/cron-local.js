import "dotenv/config";
import process from "node:process";

if (!process.env.CRON_SECRET) throw new Error("Configure CRON_SECRET para ejecutar la sincronizacion local.");
let running = false;
async function sync() {
  if (running) return;
  running = true;
  try {
    const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 3030)}/api/cron/compras`, {
      headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` }, signal: AbortSignal.timeout(240000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
    const errors = result.data.results.filter((r) => r.status === "error").length;
    console.log(`[quirofano:cron] Revisadas=${result.data.results.length} errores=${errors} pendientes=${result.data.hasMore}`);
  } catch (error) {
    console.error("[quirofano:cron]", error.message);
  } finally { running = false; }
}
await sync();
setInterval(sync, 3600000);
