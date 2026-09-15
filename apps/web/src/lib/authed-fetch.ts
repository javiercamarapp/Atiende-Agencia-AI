// Mecanismo COMPARTIDO de refresh-y-reintento ante un access token expirado
// (Hallazgo de auditoría, severidad ALTA, "duplicado en TODAS las verticales":
// "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
// redirección"). `ACCESS_TOKEN_TTL_SECONDS` por defecto es 900s (apps/api/src/env.ts)
// y POST /auth/refresh ya existe (apps/api/src/routes/auth.ts) desde que este JWT
// propio se diseñó, pero hasta esta pieza NINGÚN wrapper fetchJson/sendJson de
// ninguna vertical lo llamaba: cualquier 401 (access token vencido) se reportaba
// igual que cualquier otro error de red, sin intentar recuperarse.
//
// Este módulo NO conoce React ni `location.state` ni ninguna vertical concreta a
// propósito (mismo aislamiento que ya mantiene apps/web/src/lib/auth-client.ts): solo
// sabe pedir `makeRequest(token)`, reconocer un 401, pedir un refresh nuevo a
// `{apiBaseUrl}{ctx.refreshPath ?? "/auth/refresh"}` con el `refreshToken` que le
// entregue el `store` inyectado, y reintentar UNA vez. `refreshPath` es opcional
// (default `/auth/refresh`, el JWT genérico de `@atiende/core-auth` que comparten las
// 6 verticales de staff) — una identidad no-staff con su propio endpoint de refresh
// (ver `AuthedFetchContext.refreshPath`) pasa el suyo. Quién es "el store" (dónde vive
// la sesión
// persistida: localStorage bajo qué llave) lo decide cada
// verticals/<vertical>/lib/admin-client.ts (o dashboard-client.ts en restaurantes),
// reusando exactamente los mismos persist/read/clear que ya expone su propio
// lib/auth-client.ts — este módulo nunca toca `window`/`localStorage` directo, así
// se puede probar con un store falso en vitest (entorno "node", sin DOM, ver
// vitest.config.ts) exactamente igual que el resto de este repo.
//
// Cómo se entera el Shell de cada vertical de que la sesión ya no se pudo salvar:
// un CustomEvent en `window` (`SESSION_EXPIRED_EVENT`), NUNCA un callback inyectado
// aquí — fetchJson/sendJson de cada admin-client.ts deben conservar EXACTAMENTE su
// firma actual (mismo criterio del hallazgo: "sin romper su firma actual para los
// llamadores"), así que no hay ningún parámetro nuevo por donde un Shell pudiera
// pasarle su `onRequireLogin`. Cada Shell (HotelesShell.tsx, etc.) se suscribe a
// este evento en un `useEffect` y llama a su `onRequireLogin` ya existente — ver
// comentario en cada Shell.

/** Forma mínima de una sesión que este módulo sabe refrescar — el shape real
 * (`LoginSession` de apps/web/src/lib/auth-client.ts y de cada
 * verticals/<vertical>/lib/auth-client.ts) siempre trae también `email` y
 * `organizations`, pero este módulo nunca los toca: la respuesta de POST
 * /auth/refresh es la MISMA `issueSession()` que login (ver apps/api/src/routes/
 * auth.ts), así que sustituye la sesión completa, nunca hace merge campo a campo. */
export interface AuthedSession {
  readonly token: string;
  readonly refreshToken: string;
}

/** Cómo leer/guardar/borrar la sesión persistida de UNA vertical concreta —
 * `admin-client.ts` de cada vertical construye esto reusando literalmente sus
 * `persistXSession`/`readPersistedXSession`/`clearXSession` ya existentes (mismo
 * `SessionStorageLike`/`window.localStorage` que ya usa su Shell), no una capa de
 * almacenamiento nueva. */
export interface AuthedSessionStore<S extends AuthedSession> {
  read(): S | null;
  persist(session: S): void;
  clear(): void;
}

export interface AuthedFetchContext<S extends AuthedSession> {
  /** Identifica la vertical dueña de esta sesión en el `detail` del evento
   * `SESSION_EXPIRED_EVENT` — necesario porque las 6 verticales pueden convivir en
   * el mismo navegador/pestaña (cada una con su propia llave de localStorage, ver
   * comentario de cabecera de cada lib/auth-client.ts) y un Shell de hoteles no debe
   * reaccionar al session-expired de citas ni viceversa. */
  readonly vertical: string;
  readonly store: AuthedSessionStore<S>;
  /** Path (relativo a `apiBaseUrl`) del endpoint de refresh de ESTA sesión —
   * `"/auth/refresh"` (el default si se omite) para las 6 verticales de staff, que
   * comparten el JWT genérico de `@atiende/core-auth`. Una identidad NO-staff con su
   * propio JWT/secreto (ej. el portal de propietario de rentas,
   * `POST /rentas/owner-portal/auth/refresh`, ver owner-portal.ts) pasa aquí su
   * propio path en vez de forzar un endpoint que no existe para ella — opcional y
   * aditivo, ningún caller existente lo pasa hoy, así que su comportamiento no
   * cambia. */
  readonly refreshPath?: string;
}

/** Nombre del evento que dispara este módulo en `window` cuando un refresh falla (o
 * no hay sesión que refrescar) — cada Shell se suscribe con
 * `window.addEventListener(SESSION_EXPIRED_EVENT, ...)` y llama a su
 * `onRequireLogin` ya existente. Exportado como constante (no inline) para que
 * Shell y este módulo nunca puedan desincronizarse en el nombre del string. */
export const SESSION_EXPIRED_EVENT = "atiende:session-expired";

/** Forma mínima de almacenamiento que necesita este módulo — estructuralmente
 * idéntica a `SessionStorageLike` de apps/web/src/lib/auth-client.ts y de cada
 * verticals/<vertical>/lib/auth-client.ts (TypeScript los unifica por forma; no
 * hace falta importar el tipo de ahí, y este archivo tampoco puede nombrar
 * `Storage` de DOM — ver comentario de `defaultBrowserStorage`). */
export interface MinimalStorage {
  setItem(key: string, value: string): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/** `localStorage` del navegador real cuando existe (`globalThis === window` ahí,
 * ver comentario de `notifySessionExpired` sobre por qué nunca se nombra `window`
 * en este archivo), o `null` en cualquier entorno sin DOM real (el "node" de
 * vitest incluido). Cada `admin-client.ts`/`dashboard-client.ts` de vertical la usa
 * SOLO para construir su `AuthedFetchContext` por defecto (el que usan los
 * callers que nunca pasan uno explícito) — un test que sí quiere ejercitar el
 * mecanismo de refresh pasa su propio store falso en vez de depender de esto. */
export function defaultBrowserStorage(): MinimalStorage | null {
  const target = globalThis as { localStorage?: MinimalStorage };
  return target.localStorage ?? null;
}

export interface SessionExpiredEventDetail {
  readonly vertical: string;
}

/** Lanzado por `withAuthRefresh` cuando el 401 original no se pudo recuperar (sin
 * sesión que refrescar, o el refresh mismo respondió no-ok/reventó de red) —
 * DESPUÉS de limpiar la sesión persistida y disparar `SESSION_EXPIRED_EVENT`. Los
 * `fetchJson`/`sendJson` de cada vertical lo dejan propagar tal cual (no lo
 * reenvuelven en su propio `XAdminError`): el Shell ya está a punto de desmontar
 * este árbol vía `onRequireLogin`, así que el mensaje exacto rara vez llega a
 * pintarse, pero sigue siendo un `Error` real con `.message` legible por si algún
 * caller lo captura antes de que la navegación ocurra. */
export class SessionExpiredError extends Error {
  constructor(message = "Tu sesión expiró. Vuelve a iniciar sesión.") {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/** `globalThis` (nunca el identificador `window`) a propósito: este archivo es un
 * `.ts` plano incluido también por el `tsconfig.json` RAÍZ del monorepo (el
 * include recursivo bajo `apps/*` hacia archivos `.ts`, `"lib": ["ES2023"]`, SIN
 * `"DOM"` — a diferencia de apps/web/tsconfig.json, que sí trae DOM para los
 * `.tsx`), así que el nombre `window`/el tipo `Storage` no existen ahí — el mismo
 * motivo por el que cada
 * `persistXSession`/`readPersistedXSession` de lib/auth-client.ts recibe un
 * `SessionStorageLike` inyectado en vez de tocar `window.localStorage` directo. En
 * un navegador real `globalThis === window`, así que esto dispara el evento real;
 * en el entorno "node" de vitest (ver vitest.config.ts) `globalThis.dispatchEvent`
 * simplemente no existe y la función no hace nada — cubre tanto los tests (que de
 * todas formas siempre inyectan su propio `AuthedFetchContext` de prueba) como
 * cualquier entorno sin DOM, mismo criterio best-effort que `logout()` de
 * apps/web/src/lib/auth-client.ts. */
function notifySessionExpired(vertical: string): void {
  const target = globalThis as { dispatchEvent?: (event: Event) => boolean };
  if (typeof target.dispatchEvent !== "function") return;
  target.dispatchEvent(new CustomEvent<SessionExpiredEventDetail>(SESSION_EXPIRED_EVENT, { detail: { vertical } }));
}

function looksLikeFreshSession(value: unknown): value is AuthedSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.token === "string" && candidate.token.length > 0 && typeof candidate.refreshToken === "string" && candidate.refreshToken.length > 0;
}

/** POST {apiBaseUrl}/auth/refresh con `refreshToken` — devuelve la sesión nueva
 * completa (mismo shape que login, ver comentario de `AuthedSession`) o `null` si
 * el refresh token ya no sirve (401/400, ver apps/api/src/routes/auth.ts) o la red
 * falló. Nunca lanza: el llamador (`withAuthRefresh`) decide qué hacer con `null`. */
async function tryRefresh<S extends AuthedSession>(fetchImpl: typeof fetch, apiBaseUrl: string, refreshToken: string, refreshPath: string): Promise<S | null> {
  try {
    const res = await fetchImpl(`${apiBaseUrl}${refreshPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    return looksLikeFreshSession(body) ? (body as S) : null;
  } catch {
    // Sin red, API caída, lo que sea — tratado exactamente igual que un refresh
    // que respondió no-ok (ver comentario de cabecera de `logout()` en
    // apps/web/src/lib/auth-client.ts: la red fallando nunca debe verse distinto
    // de "el servidor dijo que no").
    return null;
  }
}

/**
 * Ejecuta `makeRequest(currentToken)`. Si la respuesta NO es 401, la devuelve tal
 * cual (caso normal — la inmensa mayoría de las llamadas). Si es 401:
 *
 * 1. Lee la sesión persistida de `ctx.store` (el `refreshToken` vive ahí, nunca se
 *    le pasa a este helper como parámetro — el `token` de acceso que expiró SÍ,
 *    porque es el que ya se estaba usando para esta llamada en particular).
 * 2. Intenta refrescarla UNA vez vía POST /auth/refresh (`tryRefresh`).
 * 3. Si funciona: persiste la sesión nueva completa (access token nuevo Y refresh
 *    token nuevo — la respuesta de /auth/refresh siempre trae ambos, ver
 *    `issueSession` en apps/api/src/routes/auth.ts) y reintenta `makeRequest` una
 *    sola vez con el token nuevo, sea cual sea su resultado (si ese segundo intento
 *    también fallara con 401 —reloj muy adelantado, condición de carrera rarísima—
 *    no se reintenta en bucle: se deja esa Response para que el caller la reporte
 *    con su manejo normal de "no-ok", ver comentario de `fetchJson` en cada
 *    admin-client.ts).
 * 4. Si NO funciona (sin sesión que refrescar, refresh 401/400, o red caída):
 *    limpia la sesión persistida, dispara `SESSION_EXPIRED_EVENT` y lanza
 *    `SessionExpiredError` — nunca deja una Response 401 "colgada" sin que algo se
 *    haya hecho con la sesión rota.
 */
export async function withAuthRefresh<S extends AuthedSession>(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  ctx: AuthedFetchContext<S>,
  currentToken: string,
  makeRequest: (token: string) => Promise<Response>,
): Promise<Response> {
  const first = await makeRequest(currentToken);
  if (first.status !== 401) return first;

  const previous = ctx.store.read();
  const refreshed = previous ? await tryRefresh<S>(fetchImpl, apiBaseUrl, previous.refreshToken, ctx.refreshPath ?? "/auth/refresh") : null;

  if (!refreshed) {
    ctx.store.clear();
    notifySessionExpired(ctx.vertical);
    throw new SessionExpiredError();
  }

  ctx.store.persist(refreshed);
  return makeRequest(refreshed.token);
}

/** `apiBaseUrl` se deriva del `url` completo que ya arma cada caller
 * (`${apiBaseUrl}/v1/...`, ver App.tsx: `API_BASE_URL` es un único origen sin path
 * para las 6 verticales) en vez de pedirse como parámetro nuevo — es exactamente lo
 * mismo que ya usa Repartidor.tsx/App.tsx (`import.meta.env.VITE_API_BASE_URL`),
 * solo que reconstruido desde la URL ya resuelta para no romper la firma de
 * `fetchJson(fetchImpl, url, token)`. Si `url` no es una URL absoluta válida (no
 * debería pasar nunca: todo caller de este repo arma `url` a partir de
 * `apiBaseUrl`), `new URL()` lanza — se deja propagar tal cual, un `url` mal
 * formado es un bug del caller, no algo que este helper deba fingir manejar. */
export function apiBaseUrlFromRequestUrl(url: string): string {
  return new URL(url).origin;
}
