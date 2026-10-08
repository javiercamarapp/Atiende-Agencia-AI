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
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError, readErrorMessage, readWriteErrorMessage } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearDespachosSession, persistDespachosSession, readPersistedDespachosSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";

export { SessionExpiredError };

export class DespachosAdminError extends Error {}

export interface BranchOption {
  readonly propertyId: string;
  readonly name: string;
}

/** Contexto de refresh de sesion de despachos (lo reutiliza el transporte del Copiloto, CHAT-11). */
export function despachosAuthContext(): AuthedFetchContext<LoginSession> {
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

export async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  authCtx: AuthedFetchContext<LoginSession> = despachosAuthContext(),
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}`, ...extraHeaders } }));
  if (!res.ok) {
    throw new DespachosAdminError(await readErrorMessage(res, `No se pudo cargar ${url} (${res.status}).`));
  }
  return (await res.json()) as T;
}

/** Descarga un archivo binario (PDF/Excel) con el mismo refresh-y-reintento ante 401 que
 * `fetchJson`. Devuelve el `Blob` y el nombre sugerido por `content-disposition`
 * (`fallbackNombre` si el servidor no lo manda). Mismo manejo de error que `fetchJson`
 * (mensaje real del servidor si viene). */
export async function fetchBlob(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  fallbackNombre: string,
  authCtx: AuthedFetchContext<LoginSession> = despachosAuthContext(),
  extraHeaders: Record<string, string> = {},
): Promise<{ readonly blob: Blob; readonly nombre: string }> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}`, ...extraHeaders } }));
  if (!res.ok) {
    throw new DespachosAdminError(await readErrorMessage(res, `No se pudo descargar el archivo (${res.status}).`));
  }
  const nombre = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallbackNombre;
  return { blob: await res.blob(), nombre };
}

export async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: unknown = {},
  extraHeaders: Record<string, string> = {},
  authCtx: AuthedFetchContext<LoginSession> = despachosAuthContext(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) =>
    fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(payload),
    }),
  );
  if (!res.ok) {
    throw new DespachosAdminError(await readWriteErrorMessage(res, `No se pudo completar la operación (${res.status}).`));
  }
  return (await res.json()) as T;
}

// Hallazgo de auditoría (rubro 15, roles/permisos, severidad MEDIA, "solo
// restaurantes permite gestionar roles desde el producto"): mismo `patchJson` que
// ya tiene licitaciones/lib/admin-client.ts (leído primero como plantilla) — hasta
// esta pasada este archivo solo tenía `postJson` (nunca PATCH), suficiente para el
// resto del panel pero no para `PATCH .../admin/staff/miembros/:userId`.
export async function patchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: unknown = {},
  extraHeaders: Record<string, string> = {},
  authCtx: AuthedFetchContext<LoginSession> = despachosAuthContext(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) =>
    fetchImpl(url, {
      method: "PATCH",
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

/** PUT con el mismo `withAuthRefresh` que `postJson`/`patchJson` (D-21: `PUT .../cartera/ficha`, `PUT .../cfdi/:id/estado-sat`). */
export async function putJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  payload: unknown = {},
  extraHeaders: Record<string, string> = {},
  authCtx: AuthedFetchContext<LoginSession> = despachosAuthContext(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) =>
    fetchImpl(url, {
      method: "PUT",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json", ...extraHeaders },
      body: JSON.stringify(payload),
    }),
  );
  if (!res.ok) {
    throw new DespachosAdminError(await readWriteErrorMessage(res, `No se pudo completar la operación (${res.status}).`));
  }
  return (await res.json()) as T;
}

/** Mismo wrapper `withAuthRefresh` que `postJson`, pero para un body de texto
 * crudo (p. ej. un XML de CFDI) en vez de JSON -- `POST
 * /despachos/:propertyId/cfdi/importar-xml` (apps/api/.../despachos/cfdi.ts)
 * espera el XML tal cual, nunca envuelto en `{ xml: "..." }`. */
export async function postXml<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  rawBody: string,
  contentType = "application/xml",
  authCtx: AuthedFetchContext<LoginSession> = despachosAuthContext(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) =>
    fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": contentType },
      body: rawBody,
    }),
  );
  if (!res.ok) {
    throw new DespachosAdminError(await readWriteErrorMessage(res, `No se pudo completar la operación (${res.status}).`));
  }
  return (await res.json()) as T;
}

/** Mismo wrapper `withAuthRefresh` que `postJson`, para DELETE sin body -- hallazgo
 * de auditoría (severidad ALTA, "Alta de organización/staff imposible sin SQL"):
 * revocar una invitación de staff (admin-staff.ts) es la primera necesidad real de
 * este verbo en despachos. */
export async function deleteJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  authCtx: AuthedFetchContext<LoginSession> = despachosAuthContext(),
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { method: "DELETE", headers: { authorization: `Bearer ${t}`, ...extraHeaders } }));
  if (!res.ok) {
    throw new DespachosAdminError(await readWriteErrorMessage(res, `No se pudo completar la operación (${res.status}).`));
  }
  return (await res.json()) as T;
}

export async function fetchBranches(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<readonly BranchOption[]> {
  const body = await fetchJson<{ branches: readonly BranchOption[] }>(fetchImpl, `${apiBaseUrl}/v1/despachos/${orgSlug}/admin/branches`, token);
  return body.branches;
}

// Hallazgo de auditoría (severidad ALTA, "un despacho solo puede operar UN
// contribuyente/cliente"): DespachosShell.tsx fijaba `branches[0]` sin importar
// cuántos contribuyentes trajera GET .../admin/branches -- aunque cada branch YA
// es un property real, org-scoped, con múltiples filas posibles (mismo modelo
// exacto que hoteles/rentas/citas/licitaciones, `core.property`; ver
// `PostgresDespachosRepository.listPropertiesForOrganization`). No hacía falta
// ningún cambio de esquema: solo faltaba dejar de descartar el resto de la lista.
// `resolveActivePropertyId` es la función pura que decide qué branch queda activo
// dado lo que el selector de la UI tenga elegido -- extraída así (en vez de
// hardcodearla en el componente) para poder probarla sin depender de un DOM/React
// renderer, que este repo no tiene configurado (vitest corre en `environment:
// "node"`, sin jsdom/testing-library -- ver vitest.config.ts).
export function resolveActivePropertyId(branches: readonly BranchOption[], selectedPropertyId: string | null): string | null {
  if (branches.length === 0) return null;
  if (selectedPropertyId !== null && branches.some((b) => b.propertyId === selectedPropertyId)) return selectedPropertyId;
  return branches[0]!.propertyId;
}
