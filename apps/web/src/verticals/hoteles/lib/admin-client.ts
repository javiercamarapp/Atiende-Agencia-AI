// Helpers compartidos por el resto de lib/*.ts del panel de staff de hoteles (Fase
// 7) — mismo criterio exacto que verticals/restaurantes/lib/admin-client.ts:
// `fetchImpl` inyectado (nunca `globalThis.fetch` directo, para poder probar la
// lógica de red real con vitest en entorno "node" sin depender de jsdom) y helpers
// genéricos que nunca inventan un mensaje de error cuando el servidor ya mandó uno
// real.
//
// Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
// "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
// redirección"): `fetchJson`/`sendJson` ahora envuelven cada llamada con
// `withAuthRefresh` (../../../lib/authed-fetch.ts) — un 401 (access token vencido a
// los 900s por defecto, ver `ACCESS_TOKEN_TTL_SECONDS` en apps/api/src/env.ts)
// dispara UN intento de POST /auth/refresh con el refreshToken persistido bajo
// "atiende.hoteles.session" y reintenta la request original una sola vez con el
// token nuevo. Firma de `fetchJson`/`sendJson` SIN CAMBIOS: cada caller de este
// repo (fraude-client.ts, folios-client.ts, etc.) sigue llamándolos exactamente
// igual, sin enterarse de que ahora pueden reintentar por dentro.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError, readErrorMessage, readWriteErrorMessage } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearHotelesSession, persistHotelesSession, readPersistedHotelesSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export { SessionExpiredError };

export class HotelesAdminError extends Error {}

/** Construida de nuevo en cada llamada (nunca cacheada a nivel de módulo) para no
 * tocar `localStorage` hasta que de verdad haga falta (un 401 real) — así los
 * tests existentes de este archivo, que nunca provocan un 401, siguen corriendo en
 * el entorno "node" de vitest (sin DOM) sin ningún cambio. */
function defaultAuthCtx(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "hoteles",
    store: {
      read: () => (storage ? readPersistedHotelesSession(storage) : null),
      persist: (session) => {
        if (storage) persistHotelesSession(storage, session);
      },
      clear: () => {
        if (storage) clearHotelesSession(storage);
      },
    },
  };
}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string, authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx()): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    throw new HotelesAdminError(await readErrorMessage(res, `No se pudo cargar ${url} (${res.status}).`));
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
  authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => {
    const headers: Record<string, string> = { authorization: `Bearer ${t}`, "content-type": "application/json" };
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    return fetchImpl(url, { method, headers, body: JSON.stringify(payload) });
  });
  if (!res.ok) {
    throw new HotelesAdminError(await readWriteErrorMessage(res, `No se pudo completar la solicitud a ${url} (${res.status}).`));
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
