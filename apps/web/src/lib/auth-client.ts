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
 * exactamente 1 (entra directo), o 2+ (selector, ver POST /auth/select-org). */
export function decideLandingPath(session: LoginSession): string {
  if (session.organizations.length === 0) return "/sin-organizacion";
  if (session.organizations.length === 1) return `/restaurantes/${session.organizations[0]!.slug}`;
  return "/seleccionar-organizacion";
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
