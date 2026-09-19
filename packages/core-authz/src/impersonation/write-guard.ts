// GUARD DE "SOLO LECTURA POR DEFAULT" — pieza que cierra el requisito no
// negociable de la tarea "Bloque C": toda escritura bajo una sesión de
// impersonación de superadmin se rechaza, salvo que el propio código que
// monta este middleware defina con claridad un conjunto permitido
// (`exemptPaths`) y lo documente.
//
// Este módulo es deliberadamente AGNÓSTICO de cómo se resuelve "¿está
// impersonando ahora mismo?" — recibe un `isImpersonating(c)` inyectado
// (mismo criterio de inyección que el resto de core-authz, ver
// admin-middleware.ts/rate-limiter.ts) para que el llamador decida la fuente
// de verdad real: en este monorepo, la verificación EN SQL de
// `core.get_active_impersonation_session_for_superadmin`/
// `core.is_impersonation_active_for_caller_and_org` (packages/db/src/
// impersonation-repository.ts), nunca solo la cookie de `cookie.ts` (esa
// sigue siendo un TTL de aplicación, no la autoridad).
//
// MÉTODOS MUTANTES: POST/PUT/PATCH/DELETE — GET/HEAD/OPTIONS siempre pasan
// (leer es exactamente lo que la impersonación de solo-lectura permite).
import type { Context, MiddlewareHandler, Next } from "hono";
import { ImpersonationWriteBlockedError } from "./errors.ts";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Verdadero si `method` es uno de los 4 verbos que este guard puede bloquear. */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

/**
 * Regla pura (sin Hono, fácil de testear exhaustivamente): dado el método,
 * si el path está exento, y si el caller está impersonando, ¿se permite?
 */
export function isWriteAllowedWhileImpersonating(input: {
  readonly method: string;
  readonly path: string;
  readonly isImpersonating: boolean;
  readonly exemptPaths?: ReadonlySet<string>;
}): boolean {
  if (!isMutatingMethod(input.method)) return true;
  if (!input.isImpersonating) return true;
  return input.exemptPaths?.has(input.path) ?? false;
}

export interface BlockWritesWhileImpersonatingOptions<TEnv extends { Variables: Record<string, unknown> }> {
  /** Resuelve si ESTE request (ya autenticado, con `userId`/`db` ya en
   *  contexto) corresponde a un superadmin con una sesión de impersonación
   *  activa VIGENTE — debe consultar la fuente de verdad real (SQL), nunca
   *  solo un valor cacheado en el JWT/cookie sin revalidar. */
  readonly isImpersonating: (c: Context<TEnv>) => Promise<boolean> | boolean;
  /** Rutas EXACTAS (mismo criterio "sin matching por prefijo" que
   *  `route-area.ts::areaByRoute`, fail-closed) que este caller declara
   *  explícitamente como parte del conjunto permitido bajo impersonación —
   *  ej. el propio endpoint de "terminar mi sesión". Vacío por default: sin
   *  excepciones, coherente con "por defecto SOLO LECTURA". */
  readonly exemptPaths?: ReadonlySet<string>;
}

/**
 * Middleware Hono: 403 (`ImpersonationWriteBlockedError`) en cualquier
 * método mutante mientras `isImpersonating(c)` sea verdadero, salvo que
 * `c.req.path` esté en `exemptPaths`. Móntalo DESPUÉS de la autenticación
 * (necesita `userId`/sesión ya resueltos para que `isImpersonating` pueda
 * consultar la sesión real del caller).
 */
export function blockWritesWhileImpersonating<TEnv extends { Variables: Record<string, unknown> }>(
  options: BlockWritesWhileImpersonatingOptions<TEnv>,
): MiddlewareHandler<TEnv> {
  return async (c: Context<TEnv>, next: Next) => {
    const method = c.req.method;
    const path = c.req.path;

    if (!isMutatingMethod(method) || options.exemptPaths?.has(path)) {
      await next();
      return;
    }

    const impersonating = await options.isImpersonating(c);
    if (!impersonating) {
      await next();
      return;
    }

    throw new ImpersonationWriteBlockedError(method, path);
  };
}
