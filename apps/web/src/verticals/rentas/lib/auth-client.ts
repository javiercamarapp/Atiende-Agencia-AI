// Lógica de login del vertical rentas — reutiliza las funciones genéricas de red/
// validación de ../../../lib/auth-client.ts (login/validateLoginForm/LoginError, que
// ya llaman POST /auth/login de @atiende/core-auth sin conocimiento de vertical) y
// SOLO redefine lo que es específico de rentas: la llave de sessionStorage/
// localStorage (para no chocar con la sesión de hoteles/restaurantes en el mismo
// navegador) y el patrón de landing path (`/rentas/:slug` en vez de
// `/hoteles/:slug`/`/restaurantes/:slug`, mismo criterio de "1 organización entra
// directo, 2+ organizaciones piden selector" ya documentado en
// decideHotelesLandingPath/decideLandingPath — una empresa gestora que administra
// propiedades de más de un anfitrión/tenant es justo el caso multi-organización real
// de rentas).
import { login, logout, LoginError, validateLoginForm } from "../../../lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../../../lib/auth-client.ts";

export { login, logout, LoginError, validateLoginForm };
export type { LoginSession, SessionStorageLike };

/** A dónde navegar tras un login exitoso: 0 organizaciones (staff invitado sin
 * asignar todavía), exactamente 1 (entra directo a ESA organización de rentas), o 2+
 * (selector, ver POST /auth/select-org) — mismo criterio que hoteles/restaurantes. */
export function decideRentasLandingPath(session: LoginSession): string {
  // Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA) — mismo
  // hueco que `decideHotelesLandingPath`: `session.organizations` trae membresías de
  // TODAS las verticales (JWT único). Filtrar por "rentas" antes de contar evita
  // mandar al selector a alguien con 1 sola organización de rentas (porque también
  // tiene, p. ej., un hotel), o peor, navegar a `/rentas/<slug-de-otra-vertical>`.
  const deRentas = session.organizations.filter((o) => o.vertical === "rentas");
  if (deRentas.length === 0) return "/sin-organizacion";
  if (deRentas.length === 1) return `/rentas/${deRentas[0]!.slug}`;
  return "/seleccionar-organizacion";
}

const SESSION_KEY = "atiende.rentas.session";

export function persistRentasSession(storage: SessionStorageLike, session: LoginSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedRentasSession(storage: SessionStorageLike): LoginSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearRentasSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}
