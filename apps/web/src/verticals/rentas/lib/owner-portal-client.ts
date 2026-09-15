// Cliente web del portal de propietario (Fase 3 rentas) — consume las rutas de
// `apps/api/src/routes/verticals/rentas/owner-portal.ts`
// (login/refresh/set-password/me/unidades/statements/statements/:id), NUNCA las de
// staff (`lib/admin-client.ts`/`lib/auth-client.ts` de esta misma carpeta): son dos
// identidades completamente distintas, con su propio JWT/secreto
// (`deps.env.rentasOwnerJwtSecret`, ver la cabecera de owner-portal.ts) y su propia
// sesión de storage (para no chocar con una sesión de STAFF de rentas abierta en el
// mismo navegador). Mismo criterio que finanzas-client.ts: los tipos se REDECLARAN
// aquí (nunca importados de `@atiende/domain-rentas` — apps/web no depende de ningún
// paquete domain-*), y `fetchImpl` siempre inyectado (nunca `globalThis.fetch`
// directo) para poder probar la lógica de red real con vitest en entorno "node".
//
// `fetchOwnerPortalJson` envuelve cada GET autenticado con `withAuthRefresh`
// (../../../lib/authed-fetch.ts) — mismo mecanismo que ya usa `admin-client.ts` de
// staff (hallazgo de auditoría "el JWT expira y el panel queda muerto"), pero con
// `refreshPath: "/rentas/owner-portal/auth/refresh"` (nunca el `/auth/refresh`
// genérico de staff, que este JWT de propietario no comparte — ver el comentario de
// cabecera de `AuthedFetchContext.refreshPath`).
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";

export { SessionExpiredError };

export class OwnerPortalError extends Error {}

export interface OwnerPortalSession {
  readonly token: string;
  readonly refreshToken: string;
  readonly ownerId: string;
  readonly email: string;
}

export interface SessionStorageLike {
  setItem(key: string, value: string): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

const SESSION_KEY = "atiende.rentas.ownerPortal.session";
const REFRESH_PATH = "/rentas/owner-portal/auth/refresh";

export function persistOwnerPortalSession(storage: SessionStorageLike, session: OwnerPortalSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedOwnerPortalSession(storage: SessionStorageLike): OwnerPortalSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OwnerPortalSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearOwnerPortalSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}

// ---------------------------------------------------------------------------
// Auth pública: login / set-password (sin sesión, ver owner-portal.ts).
// ---------------------------------------------------------------------------

export function validateOwnerPortalLoginForm(email: string, password: string): string | null {
  if (!email.trim()) return "Escribe tu correo.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Ese correo no parece válido.";
  if (!password) return "Escribe tu contraseña.";
  return null;
}

export async function ownerPortalLogin(fetchImpl: typeof fetch, apiBaseUrl: string, email: string, password: string): Promise<OwnerPortalSession> {
  const validationError = validateOwnerPortalLoginForm(email, password);
  if (validationError) throw new OwnerPortalError(validationError);

  const res = await fetchImpl(`${apiBaseUrl}/rentas/owner-portal/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
  });

  if (res.status === 401) throw new OwnerPortalError("Correo o contraseña incorrectos.");
  if (!res.ok) throw new OwnerPortalError("No se pudo iniciar sesión. Intenta de nuevo en unos minutos.");

  return (await res.json()) as OwnerPortalSession;
}

export function validateOwnerPortalActivarForm(token: string, password: string, confirmPassword: string): string | null {
  if (!token.trim()) return "Pega el token de invitación que te compartió tu administrador.";
  if (password.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  if (password !== confirmPassword) return "Las contraseñas no coinciden.";
  return null;
}

/** `POST /rentas/owner-portal/auth/set-password` -- consume el token de invitación de
 * un solo uso (ver owner-portal-invite.ts). NO devuelve una sesión (solo `{ok:true}`,
 * ver owner-portal.ts) -- el propietario hace login por separado justo después, mismo
 * criterio que el flujo real que describe el diseño Fase 3 §5. */
export async function ownerPortalActivar(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, password: string, confirmPassword: string): Promise<void> {
  const validationError = validateOwnerPortalActivarForm(token, password, confirmPassword);
  if (validationError) throw new OwnerPortalError(validationError);

  const res = await fetchImpl(`${apiBaseUrl}/rentas/owner-portal/auth/set-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: token.trim(), password }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new OwnerPortalError(body?.message ?? "El token de invitación no es válido, ya se usó, o expiró.");
  }
}

/** Hallazgo de auditoría (severidad ALTA, "el portal de propietario no tiene logout/
 * revocación real de sesión") -- `POST /rentas/owner-portal/auth/logout` (nuevo, ver
 * owner-portal.ts) revoca de verdad el refresh token del lado del servidor.
 * BEST-EFFORT a propósito, mismo criterio que `logout` genérico de staff
 * (`../../../lib/auth-client.ts`): si la red falla, el logout LOCAL (borrar la sesión
 * del navegador, ver `clearOwnerPortalSession`) debe seguir funcionando igual -- el
 * caller SIEMPRE debe llamar `clearOwnerPortalSession` después, pase lo que pase aquí. */
export async function ownerPortalLogout(fetchImpl: typeof fetch, apiBaseUrl: string, refreshToken: string): Promise<void> {
  try {
    await fetchImpl(`${apiBaseUrl}/rentas/owner-portal/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Sin red, API caída, lo que sea -- el logout local no depende de que este POST
    // haya llegado, ver comentario de arriba.
  }
}

// ---------------------------------------------------------------------------
// Lectura autenticada: me / unidades / statements (requireRentasOwnerSession).
// ---------------------------------------------------------------------------

function defaultAuthCtx(): AuthedFetchContext<OwnerPortalSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "rentas-owner-portal",
    refreshPath: REFRESH_PATH,
    store: {
      read: () => (storage ? readPersistedOwnerPortalSession(storage) : null),
      persist: (session) => {
        if (storage) persistOwnerPortalSession(storage, session);
      },
      clear: () => {
        if (storage) clearOwnerPortalSession(storage);
      },
    },
  };
}

export async function fetchOwnerPortalJson<T>(fetchImpl: typeof fetch, url: string, token: string, authCtx: AuthedFetchContext<OwnerPortalSession> = defaultAuthCtx()): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new OwnerPortalError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export interface OwnerPortalOrganizacion {
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
}

export interface OwnerPortalMe {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly organizaciones: readonly OwnerPortalOrganizacion[];
}

export interface OwnerPortalUnidad {
  readonly id: string;
  readonly name: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly organizationName: string;
}

export type TipoLineaOwnerStatement = "ingreso" | "comision_canal" | "comision_gestor" | "gasto" | "impuesto";

export interface LineaOwnerStatement {
  readonly ocupacionId: string;
  readonly tipo: TipoLineaOwnerStatement;
  readonly descripcion: string;
  readonly montoCentavos: number;
}

export interface TotalesOwnerStatement {
  readonly ingresosBrutosCentavos: number;
  readonly comisionCanalCentavos: number;
  readonly comisionGestorCentavos: number;
  readonly gastosCentavos: number;
  readonly impuestosCentavos: number;
  readonly netoCentavos: number;
}

export interface OwnerPortalStatementSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly periodo: { readonly inicio: string; readonly fin: string };
  readonly version: number;
  readonly moneda: string;
  readonly netoCentavos: number;
  readonly generadoEn: string;
}

export interface OwnerPortalStatementDetalle extends OwnerPortalStatementSummary {
  readonly totales: TotalesOwnerStatement;
  readonly lineas: readonly LineaOwnerStatement[];
  readonly motivoVersion: string | null;
}

export async function fetchOwnerPortalMe(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<OwnerPortalMe> {
  return fetchOwnerPortalJson<OwnerPortalMe>(fetchImpl, `${apiBaseUrl}/rentas/owner-portal/me`, token);
}

export async function fetchOwnerPortalUnidades(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<readonly OwnerPortalUnidad[]> {
  const body = await fetchOwnerPortalJson<{ unidades: readonly OwnerPortalUnidad[] }>(fetchImpl, `${apiBaseUrl}/rentas/owner-portal/unidades`, token);
  return body.unidades;
}

export interface FiltroOwnerPortalStatements {
  readonly propertyId?: string;
  readonly desde?: string;
  readonly hasta?: string;
}

export async function fetchOwnerPortalStatements(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, filtro: FiltroOwnerPortalStatements = {}): Promise<readonly OwnerPortalStatementSummary[]> {
  const params = new URLSearchParams();
  if (filtro.propertyId) params.set("propertyId", filtro.propertyId);
  if (filtro.desde) params.set("desde", filtro.desde);
  if (filtro.hasta) params.set("hasta", filtro.hasta);
  const query = params.toString();
  const body = await fetchOwnerPortalJson<{ statements: readonly OwnerPortalStatementSummary[] }>(fetchImpl, `${apiBaseUrl}/rentas/owner-portal/statements${query ? `?${query}` : ""}`, token);
  return body.statements;
}

export async function fetchOwnerPortalStatementDetalle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, statementId: string): Promise<OwnerPortalStatementDetalle> {
  return fetchOwnerPortalJson<OwnerPortalStatementDetalle>(fetchImpl, `${apiBaseUrl}/rentas/owner-portal/statements/${statementId}`, token);
}
