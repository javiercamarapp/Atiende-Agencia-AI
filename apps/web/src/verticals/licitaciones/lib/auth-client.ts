// Lógica de login del vertical licitaciones — reutiliza las funciones
// genéricas de red/validación de ../../../lib/auth-client.ts (login/
// validateLoginForm/LoginError, que ya llaman POST /auth/login de
// @atiende/core-auth sin conocimiento de vertical, ver diseño Fase 1 §5) y
// SOLO redefine lo que es específico de licitaciones: la llave de storage
// (para no chocar con la sesión de otra vertical en el mismo navegador) y el
// landing path (`/licitaciones/:slug`).
//
// A diferencia de hoteles (multi-hotel bajo una sola cuenta), una
// organización de licitaciones opera como property singleton (§2.1 del
// diseño) — el caso de "2+ organizaciones" del selector sigue existiendo
// igual (un mismo usuario puede pertenecer a más de una empresa
// participante), pero nunca a "2+ properties de la MISMA organización".
import { login, logout, LoginError, validateLoginForm } from "../../../lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../../../lib/auth-client.ts";

export { login, logout, LoginError, validateLoginForm };
export type { LoginSession, SessionStorageLike };

export function decideLicitacionesLandingPath(session: LoginSession): string {
  if (session.organizations.length === 0) return "/sin-organizacion";
  if (session.organizations.length === 1) return `/licitaciones/${session.organizations[0]!.slug}`;
  return "/seleccionar-organizacion";
}

const SESSION_KEY = "atiende.licitaciones.session";

export function persistLicitacionesSession(storage: SessionStorageLike, session: LoginSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedLicitacionesSession(storage: SessionStorageLike): LoginSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearLicitacionesSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}
