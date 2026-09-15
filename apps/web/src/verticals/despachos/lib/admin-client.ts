// Cliente HTTP genérico del panel de despachos (Fase 9) — mismo rol exacto que
// licitaciones/lib/admin-client.ts: `fetchJson`/`postJson` inyectan `fetchImpl`
// (nunca `globalThis.fetch` directo) para poder probarlos con vitest sin DOM, y
// `fetchBranches` resuelve el propertyId real desde el slug de la organización (la
// sesión de login, ../../../lib/auth-client.ts, solo trae
// {id, slug, nombre, vertical, rol}, nunca un propertyId — ver
// GET /v1/despachos/:orgSlug/admin/branches, apps/api/.../despachos/admin.ts).
//
// Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
// "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
// redirección"): `fetchJson`/`postJson` envuelven cada llamada con
// `withAuthRefresh` (../../../lib/authed-fetch.ts) — un 401 dispara UN intento de
// POST /auth/refresh con el refreshToken persistido bajo "atiende.despachos.session"
// y reintenta la request original una sola vez con el token nuevo. Firma SIN
// CAMBIOS: cada caller de este vertical sigue llamándolos exactamente igual.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearDespachosSession, persistDespachosSession, readPersistedDespachosSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export { SessionExpiredError };

export class DespachosAdminError extends Error {}

export interface BranchOption {
  readonly propertyId: string;
  readonly name: string;
}

function defaultAuthCtx(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "despachos",
    store: {
      read: () => (storage ? readPersistedDespachosSession(storage) : null),
      persist: (session) => {
        if (storage) persistDespachosSession(storage, session);
      },
      clear: () => {
        if (storage) clearDespachosSession(storage);
      },
    },
  };
}

export async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string, authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx()): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new DespachosAdminError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: unknown = {},
  extraHeaders: Record<string, string> = {},
  authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) =>
    fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(payload),
    }),
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new DespachosAdminError(body?.message ?? body?.error ?? `No se pudo completar la operación (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function fetchBranches(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly BranchOption[]> {
  const body = await fetchJson<{ branches: readonly BranchOption[] }>(fetchImpl, `${apiBaseUrl}/v1/despachos/${orgSlug}/admin/branches`, token);
  return body.branches;
}
