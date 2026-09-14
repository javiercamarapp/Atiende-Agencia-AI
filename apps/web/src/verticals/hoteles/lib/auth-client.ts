// Lógica de login del vertical hoteles — reutiliza las funciones genéricas de red/
// validación de ../../../lib/auth-client.ts (login/validateLoginForm/LoginError, que
// ya llaman POST /auth/login de @atiende/core-auth sin conocimiento de vertical) y
// SOLO redefine lo que es específico de hoteles: la llave de sessionStorage/
// localStorage (para no chocar con la sesión de restaurantes en el mismo navegador si
// algún día ambos paneles conviven) y el patrón de landing path
// (`/hoteles/:slug` en vez de `/restaurantes/:slug`, mismo criterio de "1 organización
// entra directo, 2+ organizaciones piden selector" que ya documenta
// decideLandingPath del vertical restaurantes — hoteles es justo el caso real que
// motivó esa regla en el diseño de core-auth: multi-hotel bajo una sola cuenta).
import { login, logout, LoginError, validateLoginForm } from "../../../lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../../../lib/auth-client.ts";

export { login, logout, LoginError, validateLoginForm };
export type { LoginSession, SessionStorageLike };

/** A dónde navegar tras un login exitoso: 0 organizaciones (staff invitado sin
 * asignar todavía), exactamente 1 (entra directo a ESE hotel), o 2+ (selector, ver
 * POST /auth/select-org) — el caso multi-hotel es, de los 5 verticales, el que
 * originalmente exigió este diseño (ver diseño Fase 1 hoteles §5, punto 2: "un staff
 * normalmente pertenece a hoteles de una sola cadena/organización", pero el selector
 * cubre el caso contrario sin repetir el bug de mezclar org_id de una organización con
 * el rol de otra). */
export function decideHotelesLandingPath(session: LoginSession): string {
  if (session.organizations.length === 0) return "/sin-organizacion";
  if (session.organizations.length === 1) return `/hoteles/${session.organizations[0]!.slug}`;
  return "/seleccionar-organizacion";
}

const SESSION_KEY = "atiende.hoteles.session";

export function persistHotelesSession(storage: SessionStorageLike, session: LoginSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedHotelesSession(storage: SessionStorageLike): LoginSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearHotelesSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}
