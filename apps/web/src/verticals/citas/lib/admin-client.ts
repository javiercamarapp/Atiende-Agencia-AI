// Helpers compartidos por el resto de lib/*.ts del panel de administración de
// citas (Fase 5) — mismo criterio que dashboard-client.ts de restaurantes:
// `fetchImpl` inyectado (nunca `globalThis.fetch` directo, para poder probar la
// lógica de red real con vitest en entorno "node" sin depender de jsdom) y un
// `fetchJson` genérico que nunca inventa un mensaje de error cuando el servidor ya
// mandó uno real.
//
// `fetchBranches` resuelve el propertyId real desde el orgSlug — la sesión de
// login (citas/lib/auth-client.ts) solo trae {id, slug, nombre, vertical, rol} de
// la organización, nunca un propertyId (las rutas de staff de este panel SÍ lo
// necesitan, ver `requirePropertyMembership` en apps/api). Llama a
// GET /v1/citas/:orgSlug/admin/branches (Fase 5 — apps/api/src/routes/verticals/citas/admin.ts),
// mismo rol que `fetchBranches` de restaurantes/dashboard-client.ts.
//
// Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
// "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
// redirección"): `fetchJson`/`sendJson` envuelven cada llamada con
// `withAuthRefresh` (../../../lib/authed-fetch.ts) — un 401 dispara UN intento de
// POST /auth/refresh con el refreshToken persistido bajo "atiende.citas.session" y
// reintenta la request original una sola vez con el token nuevo. Firma SIN
// CAMBIOS: cada caller de este vertical sigue llamándolos exactamente igual.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearCitasSession, persistCitasSession, readPersistedCitasSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export { SessionExpiredError };

export class CitasAdminError extends Error {}

function defaultAuthCtx(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "citas",
    store: {
      read: () => (storage ? readPersistedCitasSession(storage) : null),
      persist: (session) => {
        if (storage) persistCitasSession(storage, session);
      },
      clear: () => {
        if (storage) clearCitasSession(storage);
      },
    },
  };
}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string, authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx()): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new CitasAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(fetchImpl: typeof fetch, url: string, token: string, payload: unknown = {}): Promise<T> {
  return sendJson<T>(fetchImpl, url, token, "POST", payload);
}

/** Fase 8 — generalización de `postJson` a cualquier método de escritura (mismo
 * nombre y firma que `sendJson` de restaurantes/admin-client.ts, ver
 * catalog-client.ts de esa vertical): el panel de citas ahora también hace
 * PATCH (editar proveedor/servicio/tenant-config) y PUT (checkbox de
 * provider_services), no solo POST. */
export async function sendJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  method: "POST" | "PATCH" | "PUT",
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
    throw new CitasAdminError(body?.message ?? body?.error ?? `No se pudo completar la solicitud a ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export interface BranchOption {
  readonly propertyId: string;
  readonly name: string;
}

export async function fetchBranches(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly BranchOption[]> {
  const body = await fetchJson<{ branches: readonly BranchOption[] }>(fetchImpl, `${apiBaseUrl}/v1/citas/${orgSlug}/admin/branches`, token);
  return body.branches;
}
