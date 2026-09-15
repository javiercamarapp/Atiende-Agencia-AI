// Lógica de login sin React — separada de Login.tsx a propósito para poder probarla
// con vitest en entorno "node" (sin DOM/testing-library, que este repo no tiene
// instalado todavía) mientras el componente solo la conecta a inputs/estado real.
// Llama a POST /auth/login de @atiende/core-auth (ver apps/api/src/routes/auth.ts) —
// JWT propio, reemplaza el magic-link/OAuth de Google de AdminLogin.tsx del origen
// (decisión ya tomada en el diseño Fase 1 §5: el Supabase de producción de
// restaurantes ya fue borrado, no hay usuarios reales de ese flujo que preservar).

export interface OrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly rol: string;
}

export interface LoginSession {
  readonly token: string;
  readonly refreshToken: string;
  readonly email: string;
  readonly organizations: readonly OrganizationSummary[];
}

export class LoginError extends Error {}

/** Fase 14 — hallazgo de auditoría (severidad ALTA, "Invitaciones de staff sin
 * ninguna UI"): cliente real de `POST /auth/accept-invite` (ver
 * `apps/api/src/routes/auth.ts`) — mismo motivo que el resto de este archivo (login/
 * logout): aceptar una invitación es JWT propio genérico a las 6 verticales, no una
 * acción de negocio de restaurantes (aunque restaurantes sea, por ahora, la única
 * vertical que expone crear invitaciones — ver el comentario de cabecera de
 * `verticals/restaurantes/lib/admin-staff.ts`). Vive junto a `login` porque devuelve
 * exactamente la misma forma de sesión (`issueSession` del lado del servidor es
 * literalmente el mismo helper para login/refresh/accept-invite). */
export interface AcceptInviteInput {
  readonly token: string;
  readonly fullName: string;
  readonly password: string;
}

export function validateAcceptInviteForm(input: AcceptInviteInput): string | null {
  if (!input.token.trim()) return "Pega el token de invitación que te compartieron.";
  if (!input.fullName.trim()) return "Escribe tu nombre completo.";
  if (input.password.length < 8) return "La contraseña debe tener al menos 8 caracteres.";
  return null;
}

/** `fetchImpl` inyectado (nunca `globalThis.fetch` directo) — mismo criterio que
 * `login` de arriba, para poder probar la lógica real de red con vitest sin DOM. */
export async function acceptInvite(fetchImpl: typeof fetch, apiBaseUrl: string, input: AcceptInviteInput): Promise<LoginSession> {
  const validationError = validateAcceptInviteForm(input);
  if (validationError) throw new LoginError(validationError);

  const res = await fetchImpl(`${apiBaseUrl}/auth/accept-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: input.token.trim(), fullName: input.fullName.trim(), password: input.password }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new LoginError(body?.message ?? "No se pudo aceptar la invitación. Verifica el token e intenta de nuevo.");
  }

  return (await res.json()) as LoginSession;
}

export function validateLoginForm(email: string, password: string): string | null {
  if (!email.trim()) return "Escribe tu correo.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "Ese correo no parece válido.";
  if (!password) return "Escribe tu contraseña.";
  return null;
}

/** `fetchImpl` inyectado (nunca `globalThis.fetch` directo) — permite probar la
 * lógica real de red sin levantar un servidor ni depender de jsdom. */
export async function login(fetchImpl: typeof fetch, apiBaseUrl: string, email: string, password: string): Promise<LoginSession> {
  const validationError = validateLoginForm(email, password);
  if (validationError) throw new LoginError(validationError);

  const res = await fetchImpl(`${apiBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
  });

  if (res.status === 401) throw new LoginError("Correo o contraseña incorrectos.");
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new LoginError(body?.message ?? "No puedes iniciar sesión todavía.");
  }
  if (!res.ok) throw new LoginError("No se pudo iniciar sesión. Intenta de nuevo en unos minutos.");

  return (await res.json()) as LoginSession;
}

/** Hallazgo de auditoría (severidad ALTA, "sin logout explícito en el panel de
 * hoteles"): antes de esta pieza ningún vertical tenía forma de decirle al SERVIDOR
 * "esta sesión terminó" — `clearHotelesSession`/`clearSession` solo borraban
 * localStorage del navegador que hizo clic, sin invalidar nada del lado de
 * `apps/api` (ver POST /auth/logout, nuevo en esta misma pasada). Best-effort A
 * PROPÓSITO: si la red falla o la API no responde, el logout local (borrar
 * localStorage + volver a la pantalla de login) debe seguir funcionando igual — un
 * staff de recepción cerrando turno no puede quedarse atorado en el panel porque el
 * POST de logout no llegó. El caller (Login/Shell de cada vertical) SIEMPRE debe
 * llamar `clearSession`/`clearHotelesSession` después, pase lo que pase aquí. */
export async function logout(fetchImpl: typeof fetch, apiBaseUrl: string, refreshToken: string): Promise<void> {
  try {
    await fetchImpl(`${apiBaseUrl}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    // Sin red, API caída, lo que sea — el logout LOCAL (borrar la sesión del
    // navegador) no depende de que este POST haya llegado, ver comentario de arriba.
  }
}

/** A dónde navegar tras un login exitoso — mismo criterio que hoteles (multi-org
 * pide elegir), generalizado: 0 organizaciones (staff invitado sin asignar todavía),
 * exactamente 1 (entra directo), o 2+ (selector, ver POST /auth/select-org).
 *
 * Hallazgo de auditoría (severidad ALTA, "el rol repartidor aterriza en un 403
 * tras login y no tiene forma de descubrir su panel"): con exactamente 1
 * organización, un repartidor entraba a `/restaurantes/:slug` (el Dashboard de
 * KPIs, protegido por MANAGER_ROLES) y recibía 403 sin ningún enlace a su panel
 * real en `/restaurantes/:slug/repartidor` (deliberadamente fuera del nav de
 * gestión, ver Repartidor.tsx). Se resuelve en el ÚNICO lugar que decide la
 * landing, sin tocar el nav ni el 403 real del servidor. */
export function decideLandingPath(session: LoginSession): string {
  if (session.organizations.length === 0) return "/sin-organizacion";
  if (session.organizations.length === 1) {
    const org = session.organizations[0]!;
    if (org.rol === "repartidor") return `/restaurantes/${org.slug}/repartidor`;
    return `/restaurantes/${org.slug}`;
  }
  return "/seleccionar-organizacion";
}

/** Misma lógica que `decideLandingPath`, pero sin asumir "restaurantes" en el caso
 * de 1 sola organización: la usa `shell/AceptarInvitacion.tsx` (Fase 14, aceptar
 * invitación), donde SÍ se conoce el `vertical` real de la organización que trajo la
 * sesión (la invitación lo fijó), así que se usa ese en vez del hardcode que
 * `decideLandingPath` todavía tiene para el flujo de login.
 *
 * Vive aquí (junto a `decideLandingPath`, no en el componente) por el mismo motivo
 * que el resto de este archivo: poder probarla con vitest en entorno "node" sin
 * arrastrar JSX/react-router-dom al typecheck de un `.ts` de test (`tsc` con el
 * tsconfig raíz, que no trae `--jsx`, no puede resolver un import directo de un
 * `.tsx` — ver `apps/web/tsconfig.json` vs. `tsconfig.json` raíz).
 *
 * Hallazgo de auditoría (severidad ALTA, "2 puntos de entrada restantes con el bug
 * de landing-path para repartidor/staff invitado"): esta función copiaba el caso de
 * 1-sola-organización de `decideLandingPath` pero se dejó el chequeo de `org.rol` en
 * el camino — un repartidor (o cualquier rol no-gestor) que aceptaba su invitación
 * aterrizaba en el Dashboard de KPIs (protegido por MANAGER_ROLES) y recibía 403 sin
 * ningún enlace a su panel real en `/restaurantes/:slug/repartidor` (ver
 * Repartidor.tsx) — exactamente el mismo síntoma que `decideLandingPath` ya resuelve
 * para el flujo de login. Se generaliza igual: por ahora repartidor es un rol
 * exclusivo de restaurantes, pero el chequeo es por `org.rol`, no por vertical, para
 * no tener que tocar esta función el día que otra vertical sume su propio rol de
 * "solo panel operativo, sin dashboard de gestión". */
export function decideLandingPathForInvite(session: LoginSession): string {
  if (session.organizations.length === 0) return "/sin-organizacion";
  if (session.organizations.length === 1) {
    const org = session.organizations[0]!;
    if (org.rol === "repartidor") return `/${org.vertical}/${org.slug}/repartidor`;
    return `/${org.vertical}/${org.slug}`;
  }
  return "/seleccionar-organizacion";
}

/** A dónde navegar al elegir una organización de la lista en
 * `shell/SeleccionarOrganizacion.tsx` — mismo criterio de rol que
 * `decideLandingPath`/`decideLandingPathForInvite` de arriba, y vive aquí por el
 * mismo motivo (ver el comentario de `decideLandingPathForInvite`): probarla con
 * vitest sin arrastrar JSX al typecheck de un `.ts` de test.
 *
 * Hallazgo de auditoría (severidad ALTA, "2 puntos de entrada restantes con el bug
 * de landing-path para repartidor/staff invitado"): `SeleccionarOrganizacionPage`
 * navegaba siempre a `/<vertical>/<slug>` (el Dashboard de KPIs) sin importar el rol
 * de la organización elegida — un repartidor con 2+ organizaciones de restaurantes
 * que escogía aquí terminaba igual en un 403 (MANAGER_ROLES), en vez de en su panel
 * real `/restaurantes/:slug/repartidor` (ver Repartidor.tsx). */
export function decideOrganizacionSeleccionadaPath(vertical: string, org: OrganizationSummary): string {
  if (org.rol === "repartidor") return `/${vertical}/${org.slug}/repartidor`;
  return `/${vertical}/${org.slug}`;
}

export interface SessionStorageLike {
  setItem(key: string, value: string): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

const SESSION_KEY = "atiende.restaurantes.session";

export function persistSession(storage: SessionStorageLike, session: LoginSession): void {
  storage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function readPersistedSession(storage: SessionStorageLike): LoginSession | null {
  const raw = storage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LoginSession;
  } catch {
    storage.removeItem(SESSION_KEY);
    return null;
  }
}

export function clearSession(storage: SessionStorageLike): void {
  storage.removeItem(SESSION_KEY);
}
