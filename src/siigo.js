import { DomainError } from "./domain/pricing.js";

const BASE = "https://api.siigo.com";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSiigo({ username, accessKey, partnerId, writesEnabled = false,
  fetchImpl = globalThis.fetch, sleep = wait, now = Date.now } = {}) {
  let token = null;
  let expires = 0;
  let authentication;
  let requestTimes = [], requestQueue = Promise.resolve();
  const configured = Boolean(username && accessKey && partnerId);

  async function limitedFetch(url, init) {
    const previous = requestQueue;
    let release;
    requestQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      let time = now();
      requestTimes = requestTimes.filter((stamp) => stamp > time - 60000);
      while (requestTimes.length >= 100) {
        await sleep(Math.max(1, requestTimes[0] + 60001 - time));
        time = now();
        requestTimes = requestTimes.filter((stamp) => stamp > time - 60000);
      }
      requestTimes.push(time);
      return fetchImpl(url, { ...init, signal: AbortSignal.timeout(20000) });
    } finally { release(); }
  }

  async function authenticate() {
    if (!configured) throw new DomainError("Configure SIIGO_USERNAME, SIIGO_ACCESS_KEY y SIIGO_PARTNER_ID en el backend.", 503);
    if (token && expires > now()) return token;
    if (!authentication) {
      authentication = (async () => {
        const response = await limitedFetch(`${BASE}/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Partner-Id": partnerId },
          body: JSON.stringify({ username, access_key: accessKey }),
        });
        if (!response.ok) throw new DomainError(`Siigo rechazo la autenticacion (${response.status}). Revise las credenciales del backend.`, 502);
        const data = await response.json();
        if (!data.access_token || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) {
          throw new DomainError("Siigo devolvio una autenticacion incompleta.", 502);
        }
        token = data.access_token;
        expires = now() + Math.max(0, Number(data.expires_in) - 60) * 1000;
        return token;
      })().finally(() => { authentication = null; });
    }
    return authentication;
  }

  async function request(path, { method = "GET", body, attempt = 0 } = {}) {
    const bearer = await authenticate();
    let response;
    try {
      response = await limitedFetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${bearer}`, "Partner-Id": partnerId, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new DomainError(`Siigo no respondio a ${method}. ${method === "PUT" ? "El resultado es incierto: verifique antes de volver a escribir." : "Intente nuevamente."} (${error.name})`, 502);
    }
    if (method === "GET" && attempt < 2) {
      if (response.status === 401) {
        token = null;
        expires = 0;
        return request(path, { method, attempt: attempt + 1 });
      }
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after") || 1);
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) {
          await sleep(Math.max(1000, seconds * 1000));
          return request(path, { method, attempt: attempt + 1 });
        }
      }
    }
    if (!response.ok) {
      throw new DomainError(`Siigo respondio ${response.status} a ${method} ${path.split("?")[0]}. No se confirmo la operacion.`, 502);
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new DomainError("Siigo no devolvio un JSON valido. No se confirmo la operacion.", 502);
    }
  }

  const idPath = (id) => encodeURIComponent(id);
  return {
    configured, writesEnabled,
    products: async (page = 1) => {
      const data = await request(`/v1/products?page=${page}&page_size=50`);
      if (!Array.isArray(data?.results) || !Number.isInteger(data.pagination?.total_results)) {
        throw new DomainError("El listado de productos de Siigo no coincide con el contrato esperado.", 502);
      }
      return data;
    },
    product: (id) => request(`/v1/products/${idPath(id)}`),
    customer: (id) => request(`/v1/customers/${idPath(id)}`),
    purchase: (id) => request(`/v1/purchases/${idPath(id)}`),
    purchases: async (page = 1) => {
      const data = await request(`/v1/purchases?page=${page}&page_size=50`);
      if (!Array.isArray(data?.results) || !Number.isInteger(data.pagination?.total_results)) {
        throw new DomainError("El listado de compras de Siigo no coincide con el contrato esperado.", 502);
      }
      return data;
    },
    invoices: async (page = 1) => {
      const data = await request(`/v1/invoices?page=${page}&page_size=50`);
      if (!Array.isArray(data?.results) || !Number.isInteger(data.pagination?.total_results)) {
        throw new DomainError("El listado de ventas de Siigo no coincide con el contrato esperado.", 502);
      }
      return data;
    },
    priceLists: () => request("/v1/price-lists"),
    taxes: () => request("/v1/taxes"),
    updateProduct: (id, payload) => {
      if (!writesEnabled) throw new DomainError("Las escrituras en Siigo estan deshabilitadas. Configure SIIGO_WRITES_ENABLED=true despues de validar la conexion.", 409);
      return request(`/v1/products/${idPath(id)}`, { method: "PUT", body: payload });
    },
  };
}
