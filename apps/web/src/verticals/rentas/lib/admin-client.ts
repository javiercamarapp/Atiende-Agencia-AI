// Helpers compartidos por el resto de lib/*.ts del panel de staff de rentas (Fase
// 12) — mismo criterio exacto que verticals/hoteles/lib/admin-client.ts:
// `fetchImpl` inyectado (nunca `globalThis.fetch` directo, para poder probar la
// lógica de red real con vitest en entorno "node" sin depender de jsdom) y un
// helper genérico que nunca inventa un mensaje de error cuando el servidor ya mandó
// uno real.
//
// Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
// "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
// redirección"): `fetchJson`/`sendJson` envuelven cada llamada con `withAuthRefresh`
// (../../../lib/authed-fetch.ts) — un 401 dispara UN intento de POST /auth/refresh
// con el refreshToken persistido bajo "atiende.rentas.session" y reintenta la
// request original una sola vez con el token nuevo. Firma de `fetchJson`/`sendJson`
// SIN CAMBIOS: cada caller de este repo sigue pasando exactamente los mismos
// argumentos posicionales de siempre, `authCtx` es opcional al final.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearRentasSession, persistRentasSession, readPersistedRentasSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export { SessionExpiredError };

export class RentasAdminError extends Error {}

function defaultAuthCtx(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "rentas",
    store: {
      read: () => (storage ? readPersistedRentasSession(storage) : null),
      persist: (session) => {
        if (storage) persistRentasSession(storage, session);
      },
      clear: () => {
        if (storage) clearRentasSession(storage);
      },
    },
  };
}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string, authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx()): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new RentasAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

/** Fase 13 -- primer POST/PATCH real del panel de staff de rentas (calendario:
 * crear/modificar/cancelar reservas, crear/cancelar bloqueos). Ninguna ruta de
 * escritura de rentas exige `Idempotency-Key` (a diferencia de hoteles) -- mismo
 * criterio simple que `verticals/restaurantes/lib/admin-client.ts::sendJson`. */
export async function sendJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  method: "POST" | "PATCH",
  payload: unknown = {},
  authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) =>
    fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new RentasAdminError(body?.message ?? body?.error ?? `No se pudo completar la solicitud a ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}
