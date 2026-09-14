// Helpers compartidos por el resto de lib/*.ts del panel de staff de hoteles (Fase
// 7) — mismo criterio exacto que verticals/restaurantes/lib/admin-client.ts:
// `fetchImpl` inyectado (nunca `globalThis.fetch` directo, para poder probar la
// lógica de red real con vitest en entorno "node" sin depender de jsdom) y helpers
// genéricos que nunca inventan un mensaje de error cuando el servidor ya mandó uno
// real.
export class HotelesAdminError extends Error {}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new HotelesAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** A diferencia de restaurantes (solo POST/PATCH sin idempotencia), la mayoría de
 * las rutas de escritura de hoteles EXIGEN el header `Idempotency-Key` (reservas.ts/
 * folios.ts, ver diseño Fase 3/5 §doble-clic) — `idempotencyKey` es explícito aquí
 * en vez de generarse a ciegas dentro del helper, para que cada caller decida si esta
 * llamada en particular la necesita (PATCH de transición NO la exige, por ejemplo).*/
export async function sendJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  method: "POST" | "PATCH",
  payload: unknown = {},
  idempotencyKey?: string,
): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetchImpl(url, { method, headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new HotelesAdminError(body?.message ?? body?.error ?? `No se pudo completar la solicitud a ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** Genera una idempotency-key nueva por cada intento de envío — `crypto.randomUUID`
 * está disponible en todo navegador moderno (mismo requisito que ya tiene el resto
 * de este panel, sin polyfill). Reintentar el MISMO envío (p. ej. doble clic) debe
 * reusar la misma key para que el servidor lo detecte como duplicado; un envío nuevo
 * (otro cargo, otra reserva) necesita una key nueva -- por eso esto es una función que
 * el caller invoca una vez por acción, no una constante. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
