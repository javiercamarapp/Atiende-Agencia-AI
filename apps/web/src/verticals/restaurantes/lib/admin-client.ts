// Helpers compartidos por el resto de lib/*.ts del panel de back-office de
// restaurantes (Fase 5) — mismo criterio que dashboard-client.ts (Fase 3) y que
// citas/lib/admin-client.ts (Fase 5 citas): `fetchImpl` inyectado (nunca
// `globalThis.fetch` directo, para poder probar la lógica de red real con vitest en
// entorno "node" sin depender de jsdom) y helpers genéricos que nunca inventan un
// mensaje de error cuando el servidor ya mandó uno real.
//
// Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
// "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
// redirección"): `fetchJson`/`sendJson` envuelven cada llamada con
// `withAuthRefresh` (../../../lib/authed-fetch.ts) — un 401 dispara UN intento de
// POST /auth/refresh con el refreshToken persistido bajo
// "atiende.restaurantes.session" (mismo lib/auth-client.ts genérico que ya usa
// RestaurantesShell.tsx) y reintenta la request original una sola vez con el
// token nuevo. Firma SIN CAMBIOS: branches-client.ts/catalog-client.ts/
// customers-client.ts/orders-client.ts siguen llamándolos exactamente igual.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError, readErrorMessage, readWriteErrorMessage } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearSession, persistSession, readPersistedSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";

export { SessionExpiredError };

export class RestaurantesAdminError extends Error {}

function defaultAuthCtx(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "restaurantes",
    store: {
      read: () => (storage ? readPersistedSession(storage) : null),
      persist: (session) => {
        if (storage) persistSession(storage, session);
      },
      clear: () => {
        if (storage) clearSession(storage);
      },
    },
  };
}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string, authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx()): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    throw new RestaurantesAdminError(await readErrorMessage(res, `No se pudo cargar ${url} (${res.status}).`));
  }
  return (await res.json()) as T;
}

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
    throw new RestaurantesAdminError(await readWriteErrorMessage(res, `No se pudo completar la solicitud a ${url} (${res.status}).`));
  }
  return (await res.json()) as T;
}

/** Fase 14 — primer DELETE real del panel de restaurantes (revocar una invitación de
 * staff pendiente, ver staff-client.ts::revokeStaffInvite). Sin cuerpo -- ninguna ruta
 * DELETE de este vertical lo lee (mismo criterio que citas/lib/admin-client.ts::deleteJson).
 * Envuelto con `withAuthRefresh` igual que fetchJson/sendJson de arriba, por el mismo
 * hallazgo de auditoría de la cabecera de este archivo. */
export async function deleteJson<T>(fetchImpl: typeof fetch, url: string, token: string, authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx()): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { method: "DELETE", headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    throw new RestaurantesAdminError(await readWriteErrorMessage(res, `No se pudo completar la solicitud a ${url} (${res.status}).`));
  }
  return (await res.json()) as T;
}
