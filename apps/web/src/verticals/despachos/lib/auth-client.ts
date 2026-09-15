// Lógica de login del vertical despachos — reutiliza las funciones genéricas de red/
// validación de ../../../lib/auth-client.ts (login/validateLoginForm/LoginError, que
// ya llaman POST /auth/login de @atiende/core-auth sin conocimiento de vertical, el
// mismo patrón genérico ya construido para restaurantes y hoteles) y SOLO redefine lo
// que es específico de despachos: la llave de sessionStorage/localStorage (para no
// chocar con la sesión de otro vertical abierta en el mismo navegador) y el landing
// path (`/despachos/:slug`).
import { login, logout, LoginError, validateLoginForm } from "../../../lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../../../lib/auth-client.ts";

export { login, logout, LoginError, validateLoginForm };
export type { LoginSession, SessionStorageLike };

/** A dónde navegar tras un login exitoso: 0 organizaciones (staff invitado sin
 * asignar todavía), exactamente 1 (entra directo a ESE despacho — el caso normal: un
 * contador suele pertenecer a un solo despacho), o 2+ (selector, ver POST
 * /auth/select-org) — mismo criterio "1 organización entra directo, 2+ piden
 * selector" ya aplicado en hoteles/restaurantes. */
export function decideDespachosLandingPath(session: LoginSession): string {
  // Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA) — mismo
  // hueco que `decideHotelesLandingPath`: `session.organizations` trae membresías de
  // TODAS las verticales (JWT único, ver cabecera). Filtrar por "despachos" antes de
  // contar evita mandar al selector a alguien con 1 solo despacho (porque también
  // tiene, p. ej., un hotel), o peor, navegar a `/despachos/<slug-de-otra-vertical>`.
  const deDespachos = session.organizations.filter((o) => o.vertical === "despachos");
  if (deDespachos.length === 0) return "/sin-organizacion";
  if (deDespachos.length === 1) return `/despachos/${deDespachos[0]!.slug}`;
  return "/seleccionar-organizacion";
}

const SESSION_KEY = "atiende.despachos.session";

export function persistDespachosSession(storage: SessionStorageLike, session: LoginSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedDespachosSession(storage: SessionStorageLike): LoginSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearDespachosSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}
