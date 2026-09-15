// Lógica de login del vertical citas — reutiliza las funciones genéricas de red/
// validación de ../../../lib/auth-client.ts (login/validateLoginForm/LoginError, que
// ya llaman POST /auth/login de @atiende/core-auth sin conocimiento de vertical) y
// SOLO redefine lo específico de citas: la llave de sessionStorage/localStorage
// (para no chocar con la sesión de restaurantes/hoteles en el mismo navegador) y el
// patrón de landing path (`/citas/:slug`), mismo criterio "1 organización entra
// directo, 2+ organizaciones piden selector" que ya documenta decideLandingPath
// (restaurantes) / decideHotelesLandingPath.
//
// Bloqueante de producto, NO de esta fase de construcción (ver diseño Fase 1 citas
// §7.1): antes de dar de baja el login viejo de citas-reservaciones (magic-link +
// Google, AdminLogin.tsx), hay que confirmar con Javier si el Supabase de
// producción de citas (ref jfvfoettxagcqgizenum) tiene tenant_staff/auth.users con
// filas reales — a diferencia de restaurantes/hoteles, aquí NO se verificó que esté
// vacío. Si hay staff real, hace falta además un flujo de
// `POST /auth/set-initial-password` (no existe todavía) antes de poder cortar el
// login viejo — ese flujo es trabajo genuino nuevo, no un port, y queda fuera de
// esta fase de construcción hasta tener esa confirmación.
import { login, logout, LoginError, validateLoginForm } from "../../../lib/auth-client.ts";
import type { LoginSession, SessionStorageLike } from "../../../lib/auth-client.ts";

export { login, logout, LoginError, validateLoginForm };
export type { LoginSession, SessionStorageLike };

/** A dónde navegar tras un login exitoso: 0 organizaciones (staff invitado sin
 * asignar todavía), exactamente 1 (entra directo a ESE negocio), o 2+ (selector, ver
 * POST /auth/select-org). */
export function decideCitasLandingPath(session: LoginSession): string {
  // Hallazgo de auditoría (rubro 19, multi-organización, severidad MEDIA) — mismo
  // hueco que `decideHotelesLandingPath`: `session.organizations` trae membresías de
  // TODAS las verticales (JWT único, ver cabecera). Filtrar por "citas" antes de
  // contar evita mandar al selector a alguien con 1 sola cita-org (porque también
  // tiene un hotel), o peor, navegar a `/citas/<slug-de-otra-vertical>`.
  const deCitas = session.organizations.filter((o) => o.vertical === "citas");
  if (deCitas.length === 0) return "/sin-organizacion";
  if (deCitas.length === 1) return `/citas/${deCitas[0]!.slug}`;
  return "/seleccionar-organizacion";
}

const SESSION_KEY = "atiende.citas.session";

export function persistCitasSession(storage: SessionStorageLike, session: LoginSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedCitasSession(storage: SessionStorageLike): LoginSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearCitasSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}
