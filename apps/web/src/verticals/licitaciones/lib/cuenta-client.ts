// Cliente web de "Seguridad de la cuenta" (L-02): estado de la cuenta, verificacion de correo,
// cambio y restablecimiento de contrasena, sesiones activas y vinculos de Google. Rutas en
// apps/api/src/routes/auth-cuenta.ts, auth-account.ts y auth-google.ts. Mismo aislamiento que el
// resto de apps/web (no depende de `@atiende/domain-licitaciones`) y mismo criterio que
// `two-factor-client.ts`: `fetchImpl` inyectado.
//
// COMPATIBILIDAD con la base sin migrar: `fetchCuentaEstado`/`fetchSesiones` NUNCA lanzan por un
// backend sin la migracion 0033 ni por un fallo de red (devuelven "no disponible"): la pantalla
// sigue mostrando lo que SI funciona (cambio de contrasena, verificacion, cerrar sesiones por corte).
import { fetchJson, postJson } from "./admin-client.ts";
import { persistLicitacionesSession, readPersistedLicitacionesSession } from "./auth-client.ts";
import type { LoginSession } from "./auth-client.ts";
import { defaultBrowserStorage } from "../../../lib/authed-fetch.ts";

export interface GoogleIdentity {
  readonly id: string;
  readonly email: string;
  readonly linkedAt: string;
}

export interface CuentaEstado {
  /** `false` = la base todavia no tiene la migracion 0033 (o no se pudo consultar). */
  readonly available: boolean;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly hasPassword: boolean;
  readonly google: { readonly configured: boolean; readonly available: boolean; readonly identities: readonly GoogleIdentity[] };
}

export const CUENTA_NO_DISPONIBLE: CuentaEstado = {
  available: false,
  email: "",
  emailVerified: true, // ante la duda NO se ofrece "verificar": no se finge un estado que no se conoce
  hasPassword: false,
  google: { configured: false, available: false, identities: [] },
};

export async function fetchCuentaEstado(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<CuentaEstado> {
  try {
    const s = await fetchJson<Omit<CuentaEstado, "available">>(fetchImpl, `${apiBaseUrl}/auth/account/estado`, token);
    return {
      available: true,
      email: s.email,
      emailVerified: s.emailVerified === true,
      hasPassword: s.hasPassword === true,
      google: { configured: s.google?.configured === true, available: s.google?.available === true, identities: s.google?.identities ?? [] },
    };
  } catch {
    return CUENTA_NO_DISPONIBLE;
  }
}

export interface SesionActiva {
  readonly id: string;
  readonly startedAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly userAgent: string | null;
  readonly current: boolean;
}

export interface SesionesEstado {
  readonly available: boolean;
  readonly sessions: readonly SesionActiva[];
}

export const SESIONES_NO_DISPONIBLES: SesionesEstado = { available: false, sessions: [] };

/** Refresh token del dispositivo actual (para marcar "Este dispositivo"); `null` si no hay sesion persistida. */
export function currentRefreshToken(): string | null {
  const storage = defaultBrowserStorage();
  return storage ? (readPersistedLicitacionesSession(storage)?.refreshToken ?? null) : null;
}

export async function fetchSesiones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<SesionesEstado> {
  try {
    const refreshToken = currentRefreshToken();
    const s = await postJson<SesionesEstado>(fetchImpl, `${apiBaseUrl}/auth/sessions/listar`, token, refreshToken ? { refreshToken } : {});
    return { available: s.available === true, sessions: s.sessions ?? [] };
  } catch {
    return SESIONES_NO_DISPONIBLES;
  }
}

export async function cerrarSesion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, sessionId: string): Promise<void> {
  await postJson<{ ok: boolean }>(fetchImpl, `${apiBaseUrl}/auth/sessions/cerrar`, token, { sessionId });
}

/** Guarda en el navegador la sesion NUEVA que el servidor emite al cortar las demas / cambiar la contrasena. */
function persistirSesionNueva(nueva: { token: string; refreshToken: string }): void {
  const storage = defaultBrowserStorage();
  if (!storage) return;
  const actual = readPersistedLicitacionesSession(storage);
  if (!actual) return;
  const session: LoginSession = { ...actual, token: nueva.token, refreshToken: nueva.refreshToken };
  persistLicitacionesSession(storage, session);
}

/** Corta todas las demas sesiones; el servidor devuelve una sesion nueva para ESTE dispositivo. */
export async function cerrarOtrasSesiones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<void> {
  const nueva = await postJson<{ token: string; refreshToken: string }>(fetchImpl, `${apiBaseUrl}/auth/sessions/cerrar-todas`, token, {});
  persistirSesionNueva(nueva);
}

export async function cambiarContrasena(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, currentPassword: string, newPassword: string): Promise<void> {
  const nueva = await postJson<{ token: string; refreshToken: string }>(fetchImpl, `${apiBaseUrl}/auth/change-password`, token, { currentPassword, newPassword });
  persistirSesionNueva(nueva);
}

export function validarNuevaContrasena(nueva: string, confirmacion: string, actual?: string): string | null {
  if (nueva.length < 8) return "La contraseña nueva debe tener al menos 8 caracteres.";
  if (nueva.length > 200) return "La contraseña nueva no puede pasar de 200 caracteres.";
  if (nueva !== confirmacion) return "Las contraseñas no coinciden.";
  if (actual !== undefined && nueva === actual) return "La contraseña nueva debe ser distinta de la actual.";
  return null;
}

/** "Olvide mi contrasena": el servidor responde SIEMPRE el mismo 200 (exista o no el correo). */
export async function solicitarRestablecerContrasena(fetchImpl: typeof fetch, apiBaseUrl: string, email: string): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/password-reset/solicitar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, vertical: "licitaciones" }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo solicitar el enlace. Intenta de nuevo en unos minutos."));
}

export async function confirmarRestablecerContrasena(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, newPassword: string): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/password-reset/confirmar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo restablecer la contraseña."));
}

/** Reenvia el correo de verificacion; `sent: false` = el servidor no pudo enviarlo (Resend sin configurar o rechazo). */
export async function enviarVerificacionCorreo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<{ alreadyVerified: boolean; sent: boolean }> {
  const r = await postJson<{ alreadyVerified?: boolean; sent?: boolean }>(fetchImpl, `${apiBaseUrl}/auth/email-verification/enviar`, token, { vertical: "licitaciones" });
  return { alreadyVerified: r.alreadyVerified === true, sent: r.sent === true };
}

export async function confirmarVerificacionCorreo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/email-verification/confirmar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(await mensajeDeError(res, "No se pudo verificar el correo."));
}

/** Devuelve la URL de Google a la que hay que navegar para vincular la cuenta. */
export async function iniciarVinculoGoogle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<string> {
  const r = await postJson<{ url: string }>(fetchImpl, `${apiBaseUrl}/auth/google/vincular/iniciar`, token, { orgSlug });
  return r.url;
}

export async function desvincularGoogle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, identityId: string, password: string): Promise<void> {
  await postJson<{ ok: boolean }>(fetchImpl, `${apiBaseUrl}/auth/google/desvincular`, token, { identityId, password });
}

async function mensajeDeError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? fallback;
}

/** Texto corto para una sesion a partir de su User-Agent ("Chrome en macOS"). Solo cosmetico. */
export function describirDispositivo(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo desconocido";
  const ua = userAgent;
  const navegador = /Edg\//u.test(ua) ? "Edge" : /OPR\/|Opera/u.test(ua) ? "Opera" : /Firefox\//u.test(ua) ? "Firefox" : /Chrome\/|CriOS\//u.test(ua) ? "Chrome" : /Safari\//u.test(ua) ? "Safari" : null;
  const sistema = /iPhone|iPad|iPod/u.test(ua) ? "iOS" : /Android/u.test(ua) ? "Android" : /Windows/u.test(ua) ? "Windows" : /Mac OS X|Macintosh/u.test(ua) ? "macOS" : /Linux/u.test(ua) ? "Linux" : null;
  if (navegador && sistema) return `${navegador} en ${sistema}`;
  return navegador ?? sistema ?? "Dispositivo desconocido";
}
