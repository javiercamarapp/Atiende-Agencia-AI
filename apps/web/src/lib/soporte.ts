// Sesión de SOPORTE del superadmin dentro del panel de un cliente ("entrar a un cliente"). Sin React: se prueba con vitest.
// Backend: apps/api/src/routes/soporte.ts (POST /superadmin/soporte/entrar, /soporte/estado|elevar|salir) y la guarda global
// apps/api/src/soporte/guard.ts. El token de soporte lleva el claim `soporte` y vive en la sesión persistida de la vertical
// (misma llave que un login normal): el banner permanente lo lee DEL TOKEN, así que no depende de un estado aparte que pudiera
// quedar desfasado. Solo el nombre de la organización (para el texto del banner) se guarda aparte.
import type { LoginSession, SessionStorageLike } from "./auth-client.ts";
import { clearSession, persistSession } from "./auth-client.ts";
import { clearHotelesSession, persistHotelesSession } from "../verticals/hoteles/lib/auth-client.ts";
import { clearCitasSession, persistCitasSession } from "../verticals/citas/lib/auth-client.ts";
import { clearLicitacionesSession, persistLicitacionesSession } from "../verticals/licitaciones/lib/auth-client.ts";
import { clearDespachosSession, persistDespachosSession } from "../verticals/despachos/lib/auth-client.ts";
import { clearRentasSession, persistRentasSession } from "../verticals/rentas/lib/auth-client.ts";

export const MOTIVO_SOPORTE_MINIMO = 10;
export const MOTIVO_SOPORTE_MAXIMO = 500;
const META_KEY = "atiende.soporte.sesion";

/** Motivo recortado si cumple el mínimo; `null` en cualquier otro caso (vacío, null, undefined, solo espacios, número, corto). */
export function motivoSoporteValido(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.trim();
  return m.length >= MOTIVO_SOPORTE_MINIMO && m.length <= MOTIVO_SOPORTE_MAXIMO ? m : null;
}

// Mismo mapa que `superadmin/pages/Paneles.tsx` (persistir) y su gemelo para borrar: una sesión por vertical, llaves independientes.
export const PERSISTIR_POR_VERTICAL: Record<string, (storage: SessionStorageLike, session: LoginSession) => void> = {
  restaurantes: persistSession,
  hoteles: persistHotelesSession,
  citas: persistCitasSession,
  licitaciones: persistLicitacionesSession,
  despachos: persistDespachosSession,
  rentas: persistRentasSession,
};
export const LIMPIAR_POR_VERTICAL: Record<string, (storage: SessionStorageLike) => void> = {
  restaurantes: clearSession,
  hoteles: clearHotelesSession,
  citas: clearCitasSession,
  licitaciones: clearLicitacionesSession,
  despachos: clearDespachosSession,
  rentas: clearRentasSession,
};

export interface SoporteDelToken {
  readonly sid: string;
  readonly soloLectura: boolean;
  readonly expiresAtMs: number;
  readonly organizationId: string;
  readonly vertical: string;
}

/** Lee el claim `soporte` del payload del JWT (SIN verificar firma: es solo para pintar; la API verifica en cada petición). */
export function leerSoporteDelToken(token: string | null | undefined): SoporteDelToken | null {
  if (!token) return null;
  const partes = token.split(".");
  if (partes.length !== 3 || !partes[1]) return null;
  try {
    const base64 = partes[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = typeof atob === "function" ? atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")) : Buffer.from(base64, "base64").toString("utf8");
    const p = JSON.parse(json) as { soporte?: { sid?: unknown; ro?: unknown }; exp?: unknown; org_id?: unknown; vertical?: unknown };
    if (!p.soporte || typeof p.soporte.sid !== "string" || typeof p.exp !== "number" || typeof p.org_id !== "string") return null;
    return { sid: p.soporte.sid, soloLectura: p.soporte.ro !== false, expiresAtMs: p.exp * 1000, organizationId: p.org_id, vertical: typeof p.vertical === "string" ? p.vertical : "restaurantes" };
  } catch {
    return null;
  }
}

/** Lo que queda de la sesión como `hh:mm` ("caduca en 00:42"); nunca negativo. */
export function formatearRestante(expiresAtMs: number, nowMs: number): string {
  const totalMin = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function guardarNombreOrganizacion(storage: SessionStorageLike, sid: string, nombre: string): void {
  try {
    storage.setItem(META_KEY, JSON.stringify({ sid, nombre }));
  } catch {
    // Solo cosmético: sin esto el banner dice «esta organización».
  }
}
export function leerNombreOrganizacion(storage: SessionStorageLike, sid: string): string | null {
  try {
    const raw = storage.getItem(META_KEY);
    const p = raw ? (JSON.parse(raw) as { sid?: string; nombre?: string }) : null;
    return p && p.sid === sid && typeof p.nombre === "string" ? p.nombre : null;
  } catch {
    return null;
  }
}
export function olvidarNombreOrganizacion(storage: SessionStorageLike): void {
  try {
    storage.removeItem(META_KEY);
  } catch {
    // nada
  }
}

export interface SesionSoporteAbierta {
  readonly vertical: string;
  readonly slug: string;
  readonly session: LoginSession;
  readonly soporte: SoporteDelToken;
  readonly nombre: string;
}

/** Cierra la sesión de soporte del navegador: borra la sesión de la vertical y el nombre guardado. No toca la del superadmin. */
export function limpiarSesionSoporteLocal(storage: SessionStorageLike, vertical: string): void {
  (LIMPIAR_POR_VERTICAL[vertical] ?? clearSession)(storage);
  olvidarNombreOrganizacion(storage);
}

/** Pide a la API que termine la sesión (revoca la concesión temporal y escribe `end` en la bitácora). Best-effort: el cierre local siempre ocurre. */
export async function salirDeSoporte(fetchImpl: typeof fetch, apiBaseUrl: string, tokenSoporte: string): Promise<void> {
  try {
    await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}/soporte/salir`, { method: "POST", headers: { authorization: `Bearer ${tokenSoporte}` } });
  } catch {
    // Sin red: la sesión vence sola (60 min) y la guarda de la API la niega si ya terminó.
  }
}

/** «Permitir edición»: segundo motivo (>= 10) -> token nuevo con `ro:false`. Lanza `Error` con el mensaje de la API. */
export async function elevarSoporte(fetchImpl: typeof fetch, apiBaseUrl: string, tokenSoporte: string, motivo: unknown): Promise<string> {
  const limpio = motivoSoporteValido(motivo);
  if (!limpio) throw new Error(`El motivo es obligatorio (mínimo ${MOTIVO_SOPORTE_MINIMO} caracteres).`);
  const res = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}/soporte/elevar`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenSoporte}`, "content-type": "application/json" },
    body: JSON.stringify({ reason: limpio }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? "No se pudo habilitar la edición.");
  }
  return ((await res.json()) as { token: string }).token;
}

export async function consultarEstadoSoporte(fetchImpl: typeof fetch, apiBaseUrl: string, tokenSoporte: string): Promise<{ active: boolean; elevated: boolean } | null> {
  try {
    const res = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}/soporte/estado`, { headers: { authorization: `Bearer ${tokenSoporte}` } });
    if (res.status === 401) return { active: false, elevated: false };
    if (!res.ok) return null;
    const b = (await res.json()) as { active?: boolean; elevated?: boolean };
    return { active: b.active === true, elevated: b.elevated === true };
  } catch {
    return null;
  }
}

interface RespuestaEntrar {
  readonly token: string;
  readonly refreshToken: string;
  readonly session: { readonly id: string; readonly organizationName: string; readonly organizationSlug: string; readonly vertical: string };
}

/**
 * Entra al panel de una organización de cliente: (1) abre la sesión con motivo en la bitácora y recibe el token de soporte,
 * (2) resuelve la sesión del shell con `/auth/me`, (3) la persiste bajo la llave de esa vertical. Si el paso 2 o 3 falla, cierra
 * la sesión recién abierta. `entrarFn` es el POST del superadmin (con su Bearer y step-up), inyectado para no acoplar este módulo.
 */
export async function entrarComoSoporte(
  deps: { readonly fetchImpl: typeof fetch; readonly apiBaseUrl: string; readonly storage: SessionStorageLike; readonly entrarFn: (organizationId: string, reason: string) => Promise<RespuestaEntrar> },
  organizationId: string,
  motivo: unknown,
): Promise<SesionSoporteAbierta> {
  const reason = motivoSoporteValido(motivo);
  if (!reason) throw new Error(`El motivo es obligatorio (mínimo ${MOTIVO_SOPORTE_MINIMO} caracteres).`);
  const abierta = await deps.entrarFn(organizationId, reason);
  const base = deps.apiBaseUrl.replace(/\/$/, "");
  try {
    const resMe = await deps.fetchImpl(`${base}/auth/me`, { headers: { authorization: `Bearer ${abierta.token}` } });
    if (!resMe.ok) throw new Error("No se pudo cargar la sesión del cliente.");
    const me = (await resMe.json()) as { email: string; fullName?: string; organizations: LoginSession["organizations"] };
    const session: LoginSession = { token: abierta.token, refreshToken: abierta.refreshToken, email: me.email, fullName: me.fullName ?? "", organizations: me.organizations };
    const soporte = leerSoporteDelToken(abierta.token);
    const persistir = PERSISTIR_POR_VERTICAL[abierta.session.vertical];
    if (!soporte || !persistir) throw new Error("La respuesta de soporte no es válida.");
    persistir(deps.storage, session);
    guardarNombreOrganizacion(deps.storage, soporte.sid, abierta.session.organizationName);
    return { vertical: abierta.session.vertical, slug: abierta.session.organizationSlug, session, soporte, nombre: abierta.session.organizationName };
  } catch (err) {
    await salirDeSoporte(deps.fetchImpl, deps.apiBaseUrl, abierta.token);
    throw err;
  }
}
