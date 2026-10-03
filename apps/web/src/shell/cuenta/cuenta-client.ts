// Cliente web de la cuenta de staff, COMPARTIDO por las 6 verticales (PL-21; antes vivia solo en
// verticals/licitaciones/lib/cuenta-client.ts): estado de la cuenta, verificacion de correo, cambio y
// restablecimiento de contrasena, sesiones activas y vinculos de Google. Rutas del servidor:
// apps/api/src/routes/auth-cuenta.ts, auth-account.ts y auth-google.ts (el JWT propio es el unico mecanismo
// de sesion y las 6 verticales lo comparten).
//
// Lo unico que cambia por vertical es DONDE vive la sesion persistida (`atiende.<vertical>.session`, la misma
// llave que ya usa el auth-client de cada vertical): de ahi salen el refresh ante un 401 y el reemplazo de la
// sesion cuando el servidor emite una nueva (cambio de contrasena / "cerrar las demas"). Por eso las llamadas
// autenticadas se obtienen de `clienteCuenta(vertical)`.
//
// COMPATIBILIDAD con la base sin migrar: `fetchCuentaEstado`/`fetchSesiones` NUNCA lanzan por un backend sin la
// migracion 0033 ni por un fallo de red (devuelven "no disponible"): la pantalla sigue mostrando lo que SI
// funciona (cambio de contrasena, verificacion, cerrar sesiones por corte). `fetchImpl` se inyecta (nunca
// `globalThis.fetch` directo) para probar la logica real de red sin DOM.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, readErrorMessage, readWriteErrorMessage, withAuthRefresh } from "../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../lib/authed-fetch.ts";
import type { LoginSession } from "../../lib/auth-client.ts";

export const VERTICALES_CUENTA = ["hoteles", "restaurantes", "rentas", "licitaciones", "citas", "despachos"] as const;
export type VerticalCuenta = (typeof VERTICALES_CUENTA)[number];

export function esVerticalCuenta(valor: string): valor is VerticalCuenta {
  return (VERTICALES_CUENTA as readonly string[]).includes(valor);
}

export class CuentaError extends Error {}

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

export function validarNuevaContrasena(nueva: string, confirmacion: string, actual?: string): string | null {
  if (nueva.length < 8) return "La contraseña nueva debe tener al menos 8 caracteres.";
  if (nueva.length > 200) return "La contraseña nueva no puede pasar de 200 caracteres.";
  if (nueva !== confirmacion) return "Las contraseñas no coinciden.";
  if (actual !== undefined && nueva === actual) return "La contraseña nueva debe ser distinta de la actual.";
  return null;
}

/** Llave de localStorage de la sesion de `vertical` (la misma que usa el auth-client de cada vertical). */
export function claveSesion(vertical: VerticalCuenta): string {
  return `atiende.${vertical}.session`;
}

function contextoAuth(vertical: VerticalCuenta): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  const clave = claveSesion(vertical);
  return {
    vertical,
    store: {
      read: () => {
        const raw = storage?.getItem(clave);
        if (!raw) return null;
        try {
          return JSON.parse(raw) as LoginSession;
        } catch {
          storage?.removeItem(clave);
          return null;
        }
      },
      persist: (session) => storage?.setItem(clave, JSON.stringify(session)),
      clear: () => storage?.removeItem(clave),
    },
  };
}

// --- Publico (sin sesion): el canje del enlace del correo es SIEMPRE un POST ---------------------------------

/** "Olvide mi contrasena": el servidor responde SIEMPRE el mismo 200 (exista o no el correo). */
export async function solicitarRestablecerContrasena(fetchImpl: typeof fetch, apiBaseUrl: string, email: string, vertical: VerticalCuenta): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/password-reset/solicitar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim(), vertical }),
  });
  if (!res.ok) throw new CuentaError(await readWriteErrorMessage(res, "No se pudo solicitar el enlace. Intenta de nuevo en unos minutos."));
}

export async function confirmarRestablecerContrasena(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, newPassword: string): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/password-reset/confirmar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  if (!res.ok) throw new CuentaError(await readWriteErrorMessage(res, "No se pudo restablecer la contraseña."));
}

export async function confirmarVerificacionCorreo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/auth/email-verification/confirmar`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new CuentaError(await readWriteErrorMessage(res, "No se pudo verificar el correo."));
}

// --- Autenticado: la sesion vive en la llave de la vertical ---------------------------------------------------

export function clienteCuenta(vertical: VerticalCuenta) {
  const ctx = contextoAuth(vertical);

  async function leer<T>(fetchImpl: typeof fetch, url: string, token: string): Promise<T> {
    const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), ctx, token, (t) => fetchImpl(url, { headers: { authorization: `Bearer ${t}` } }));
    if (!res.ok) throw new CuentaError(await readErrorMessage(res, `No se pudo cargar ${url} (${res.status}).`));
    return (await res.json()) as T;
  }

  async function enviar<T>(fetchImpl: typeof fetch, url: string, token: string, payload: unknown = {}): Promise<T> {
    const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), ctx, token, (t) =>
      fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify(payload) }),
    );
    if (!res.ok) throw new CuentaError(await readWriteErrorMessage(res, `No se pudo completar la operación (${res.status}).`));
    return (await res.json()) as T;
  }

  /** Refresh token del dispositivo actual (para marcar "Este dispositivo"); `null` si no hay sesion persistida. */
  function currentRefreshToken(): string | null {
    return ctx.store.read()?.refreshToken ?? null;
  }

  /** Guarda en el navegador la sesion NUEVA que el servidor emite al cortar las demas / cambiar la contrasena. */
  function persistirSesionNueva(nueva: { token: string; refreshToken: string }): void {
    const actual = ctx.store.read();
    if (!actual) return;
    ctx.store.persist({ ...actual, token: nueva.token, refreshToken: nueva.refreshToken });
  }

  return {
    vertical,
    currentRefreshToken,

    async fetchCuentaEstado(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<CuentaEstado> {
      try {
        const s = await leer<Omit<CuentaEstado, "available">>(fetchImpl, `${apiBaseUrl}/auth/account/estado`, token);
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
    },

    async fetchSesiones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<SesionesEstado> {
      try {
        const refreshToken = currentRefreshToken();
        const s = await enviar<SesionesEstado>(fetchImpl, `${apiBaseUrl}/auth/sessions/listar`, token, refreshToken ? { refreshToken } : {});
        return { available: s.available === true, sessions: s.sessions ?? [] };
      } catch {
        return SESIONES_NO_DISPONIBLES;
      }
    },

    async cerrarSesion(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, sessionId: string): Promise<void> {
      await enviar<{ ok: boolean }>(fetchImpl, `${apiBaseUrl}/auth/sessions/cerrar`, token, { sessionId });
    },

    /** Corta todas las demas sesiones; el servidor devuelve una sesion nueva para ESTE dispositivo. */
    async cerrarOtrasSesiones(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<void> {
      persistirSesionNueva(await enviar<{ token: string; refreshToken: string }>(fetchImpl, `${apiBaseUrl}/auth/sessions/cerrar-todas`, token, {}));
    },

    /** Camino de respaldo si la lista de dispositivos no esta disponible: corte por fecha de las sesiones previas. */
    async cerrarOtrasSesionesPorCorte(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<void> {
      const url = `${apiBaseUrl}/auth/revoke-sessions`;
      const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), ctx, token, (t) =>
        fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: "{}" }),
      );
      if (!res.ok) throw new CuentaError(`No se pudieron cerrar las sesiones (${res.status}).`);
    },

    async cambiarContrasena(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, currentPassword: string, newPassword: string): Promise<void> {
      persistirSesionNueva(await enviar<{ token: string; refreshToken: string }>(fetchImpl, `${apiBaseUrl}/auth/change-password`, token, { currentPassword, newPassword }));
    },

    /** Reenvia el correo de verificacion; `sent: false` = el servidor no pudo enviarlo (Resend sin configurar o rechazo). */
    async enviarVerificacionCorreo(fetchImpl: typeof fetch, apiBaseUrl: string, token: string): Promise<{ alreadyVerified: boolean; sent: boolean }> {
      const r = await enviar<{ alreadyVerified?: boolean; sent?: boolean }>(fetchImpl, `${apiBaseUrl}/auth/email-verification/enviar`, token, { vertical });
      return { alreadyVerified: r.alreadyVerified === true, sent: r.sent === true };
    },

    /** Devuelve la URL de Google a la que hay que navegar para vincular la cuenta. */
    async iniciarVinculoGoogle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<string> {
      const r = await enviar<{ url: string }>(fetchImpl, `${apiBaseUrl}/auth/google/vincular/iniciar`, token, { orgSlug, vertical });
      return r.url;
    },

    async desvincularGoogle(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, identityId: string, password: string): Promise<void> {
      await enviar<{ ok: boolean }>(fetchImpl, `${apiBaseUrl}/auth/google/desvincular`, token, { identityId, password });
    },
  };
}

export type ClienteCuenta = ReturnType<typeof clienteCuenta>;

/** Texto corto para una sesion a partir de su User-Agent ("Chrome en macOS"). Solo cosmetico. */
export function describirDispositivo(userAgent: string | null): string {
  if (!userAgent) return "Dispositivo desconocido";
  const ua = userAgent;
  const navegador = /Edg\//u.test(ua) ? "Edge" : /OPR\/|Opera/u.test(ua) ? "Opera" : /Firefox\//u.test(ua) ? "Firefox" : /Chrome\/|CriOS\//u.test(ua) ? "Chrome" : /Safari\//u.test(ua) ? "Safari" : null;
  const sistema = /iPhone|iPad|iPod/u.test(ua) ? "iOS" : /Android/u.test(ua) ? "Android" : /Windows/u.test(ua) ? "Windows" : /Mac OS X|Macintosh/u.test(ua) ? "macOS" : /Linux/u.test(ua) ? "Linux" : null;
  if (navegador && sistema) return `${navegador} en ${sistema}`;
  return navegador ?? sistema ?? "Dispositivo desconocido";
}
