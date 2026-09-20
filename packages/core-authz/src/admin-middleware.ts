// ═══════════════════════════════════════════════════════════════════════════
// GATEO DE /admin/* — las 3 piezas combinadas de esta fase:
//   1. route-area.ts   (patrón proyecto-origen/src/lib/auth/visibilidad.ts)
//   2. roles.ts         (patrón atiende-ai/src/lib/auth/current-staff.ts)
//   3. audit.ts + rate-limiter.ts, aplicados AQUÍ sobre el intento DENEGADO
//      (pieza que ningún repo de referencia tenía — ver cabecera de audit.ts)
//
// Se apoya en `@atiende/core-auth` (autenticación: quién es el usuario, JWT
// verificado — `authMiddleware`/`dbSession`) y en `@atiende/core-tenancy`
// (el modelo: `PlatformRole`, `TenantDbSession`). core-authz nunca reimplementa
// esas dos capas, solo las consume — mismo layering que
// `core-auth/src/middleware.ts` ya usa para `TenancyEngine`.
// ═══════════════════════════════════════════════════════════════════════════
import type { Context, MiddlewareHandler, Next } from "hono";
import type { PlatformRole } from "@atiende/core-tenancy";
import { ApiError, Errors, type CoreAuthHonoEnv } from "@atiende/core-auth";
import { hasAnyPlatformRole } from "./roles.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type { AuditSink, AuthzAuditEntry, DenialReason } from "./audit.ts";
import { InMemoryDenialAuditCoalescer, type DenialAuditCoalescer } from "./denial-audit-coalescer.ts";
import type { RouteAreaMap } from "./route-area.ts";

type Ctx = Context<CoreAuthHonoEnv>;

export const ADMIN_ROUTE_PREFIX = "/admin";

/** ¿`path` cae bajo `/admin` o `/admin/*`? Exacto y por prefijo con separador
 * — "/administracion" NO cuenta (evita falsos positivos de prefijo simple). */
export function isAdminRoute(path: string): boolean {
  return path === ADMIN_ROUTE_PREFIX || path.startsWith(`${ADMIN_ROUTE_PREFIX}/`);
}

interface MembershipRow {
  readonly organization_id: string;
  readonly platform_role: PlatformRole;
  readonly vertical_role: string;
}

/**
 * Generaliza `requirePropertyMembership` (core-auth/src/middleware.ts) al
 * caso de rutas /admin que operan a nivel de ORGANIZACIÓN, no de una property
 * concreta de la URL — ej. `/admin/usuarios`, `/admin/facturacion`, sin
 * `:propertyId`. Misma regla ADR-004: la autoridad real es la membership
 * verificada EN VIVO contra `core.membership`, nunca el claim del JWT
 * (`organizationId` que puso `authMiddleware` solo sirve para saber A QUÉ
 * organización preguntar — se RESCRIBE con lo que la consulta devuelva).
 * Dejas `platformRole`/`verticalRole` en el contexto igual que
 * `requirePropertyMembership`, para que `requireAdminAccess` (abajo) los lea.
 */
export function requireOrganizationMembership(): MiddlewareHandler<CoreAuthHonoEnv> {
  return async (c: Ctx, next: Next) => {
    const organizationId = c.get("organizationId");
    if (!organizationId) throw Errors.unauthorized();

    const db = c.get("db");
    const { rows } = await db.query<MembershipRow>(
      `select organization_id, platform_role, vertical_role
       from core.membership
       where organization_id = $1
         and user_id = auth.uid();`,
      [organizationId],
    );

    if (rows.length === 0) {
      // Fail-closed explícito: sin fila de membership, ni "member" por default.
      c.set("platformRole", undefined);
      c.set("verticalRole", undefined);
      await next();
      return;
    }
    const row = rows[0]!;
    c.set("organizationId", row.organization_id);
    c.set("platformRole", row.platform_role);
    c.set("verticalRole", row.vertical_role);
    await next();
  };
}

export interface RequireAdminAccessOptions {
  /** Roles de plataforma que SÍ pueden pasar. Default: owner y admin — el
   * mismo techo que `canManageTeam` en current-staff.ts reserva a "owner",
   * ampliado a "admin" porque /admin/* aquí es la consola operativa completa,
   * no solo gestión de equipo/billing. */
  readonly allowedRoles?: readonly PlatformRole[];
  /** Alternativa a `allowedRoles`: gatea por ÁREA usando un route-area map
   * (pieza 1) en vez de una lista fija de roles — útil cuando /admin/* tiene
   * sub-secciones con distinto techo (ej. "administracion" vs "dinero").
   * Si se pasan los dos, `routeAreaMap` decide y `allowedRoles` se ignora. */
  readonly routeAreaMap?: RouteAreaMap<string>;
  readonly audit: AuditSink;
  readonly rateLimiter: RateLimiter;
  /** Cuántos intentos DENEGADOS por actor+ruta se toleran antes del 429.
   * Consume tokens del `rateLimiter` inyectado — default 1 token por intento
   * denegado (el propio `rateLimiter` ya trae su capacidad/reposición). */
  readonly denialCost?: number;
  /** De dónde sacar la llave de actor para rate-limit/auditoría cuando no hay
   * `userId` (pre-auth, o auth falló antes de llegar aquí) — default: IP de
   * `X-Forwarded-For`, y si tampoco hay, `"anon"`. Cambiarla en tests o para
   * usar otro header de tu infra (Vercel, Cloudflare, etc.). */
  readonly anonymousActorKey?: (c: Ctx) => string;
  /** Reloj inyectable para que `at` en el audit entry sea determinista en tests. */
  readonly now?: () => Date;
  /** Coalescer de 429 repetidas del mismo actor+ruta -- ver
   *  `DenialAuditCoalescer` (denial-audit-coalescer.ts) para el porqué
   *  (amplificación de carga hacia la base: una transacción de sistema
   *  completa por CADA request ya bloqueado, sin evidencia nueva). Default:
   *  una instancia propia con ventana de `DEFAULT_RATE_LIMITED_AUDIT_
   *  COALESCE_WINDOW_MS` (10 minutos, alineada con la ventana móvil del tope
   *  defensivo de `core.record_authz_audit_denial`, aunque son mecanismos
   *  independientes). Inyectable para tests deterministas o para compartir
   *  una instancia entre varias rutas montadas con `requireAdminAccess`. */
  readonly denialAuditCoalescer?: DenialAuditCoalescer;
}

/** 10 minutos -- mismo orden de magnitud que la ventana móvil del tope
 *  defensivo de `core.record_authz_audit_denial`
 *  (packages/db/migrations/0021_superadmin_authz_audit_log.sql/0022_
 *  superadmin_bitacoras_endurecimiento.sql), aunque son dos mecanismos
 *  independientes (este coalescer vive en memoria de aplicación, antes de
 *  que la escritura siquiera se intente; el tope SQL protege la CAPACIDAD de
 *  la tabla del lado de la base). */
const DEFAULT_RATE_LIMITED_AUDIT_COALESCE_WINDOW_MS = 10 * 60_000;

function defaultAnonymousActorKey(c: Ctx): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "anon";
}

/** Último salto de `X-Forwarded-For` (nunca el primero, que el cliente puede
 * fabricar libremente), con `X-Real-IP` como respaldo -- mismo criterio ya
 * auditado y corregido en `apps/api/src/http-security.ts::requestActor`
 * (hallazgo real de revisión, ronda r5, PR #167: confiar en el primer salto
 * o en una cabecera que el cliente controla permite evadir un rate-limit
 * rotando la cabecera, o culpar a un tercero legítimo). Replicada aquí (en
 * vez de importada) porque `@atiende/core-authz` no depende de `apps/api` --
 * es la MISMA lógica ya revisada, no una reinvención. Usada SOLO para lo que
 * `record()` puede persistir de forma duradera (ver
 * `AuthzAuditEntry.ip`/`apps/api/src/production/authz-audit-sink.ts`) --
 * `defaultAnonymousActorKey` (arriba, la llave del rate-limiter EN MEMORIA,
 * comportamiento sin cambios en esta revisión) sigue usando el primer salto a
 * propósito, para no alterar ningún bucket ya en curso. */
function resolveNormalizedIp(c: Ctx): string | null {
  const forwarded = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  const realIp = c.req.header("x-real-ip")?.trim();
  return forwarded || realIp || null;
}

/**
 * El middleware final de esta fase: se monta DESPUÉS de `authMiddleware` +
 * `dbSession` + (`requireOrganizationMembership` o `requirePropertyMembership`)
 * en cualquier ruta bajo `/admin/*`.
 *
 * Por cada request:
 *   1. Resuelve si el `platformRole` ya en contexto autoriza (por
 *      `routeAreaMap.canViewRoute` o por `allowedRoles` — pieza 1 y 2).
 *   2. Si SÍ autoriza -> `next()`. No audita el camino feliz: ese ya lo cubre
 *      `logAdminAction`-style dentro de cada handler si la acción lo amerita
 *      (fuera del alcance de este middleware, que es el GATEO, no el log de
 *      negocio de qué se hizo).
 *   3. Si NO autoriza -> consume 1 token del `rateLimiter` para la llave
 *      `actor+ruta` (pieza 3a), audita SIEMPRE la denegación con el motivo
 *      real (pieza 3b) y responde 403 — o, si ese consumo YA agotó el
 *      bucket, audita como `rate_limited` y responde 429. Un usuario sin
 *      permiso insistiendo contra /admin queda auditado en CADA intento y
 *      termina bloqueado por el rate limiter, nunca solo "rechazado en
 *      silencio".
 */
export function requireAdminAccess(options: RequireAdminAccessOptions): MiddlewareHandler<CoreAuthHonoEnv> {
  const allowedRoles = options.allowedRoles ?? (["owner", "admin"] as const);
  const denialCost = options.denialCost ?? 1;
  const anonymousActorKey = options.anonymousActorKey ?? defaultAnonymousActorKey;
  const now = options.now ?? (() => new Date());
  const denialAuditCoalescer = options.denialAuditCoalescer ?? new InMemoryDenialAuditCoalescer(DEFAULT_RATE_LIMITED_AUDIT_COALESCE_WINDOW_MS);

  return async (c: Ctx, next: Next) => {
    const path = c.req.path;
    const method = c.req.method;
    const userId = c.get("userId") ?? null;
    const platformRole = c.get("platformRole");

    const authorized = options.routeAreaMap
      ? platformRole !== undefined && options.routeAreaMap.canViewRoute(platformRole, path)
      : platformRole !== undefined && hasAnyPlatformRole(platformRole, allowedRoles);

    if (authorized) {
      await next();
      return;
    }

    const actorKey = userId ?? anonymousActorKey(c);
    const rateLimitKey = `admin-denial:${actorKey}:${path}`;
    const rl = options.rateLimiter.consume(rateLimitKey, denialCost);

    const reason: DenialReason = platformRole === undefined ? "no_membership" : "insufficient_role";
    const finalReason: DenialReason = rl.allowed ? reason : "rate_limited";

    // Coalescer SOLO para 429 repetidas del mismo actor+ruta -- ver
    // DenialAuditCoalescer para el porqué. Un 403 (insufficient_role/
    // no_membership) SIEMPRE se audita, sin coalescer.
    let shouldPersist = true;
    let suppressedSincePersist = 0;
    if (finalReason === "rate_limited") {
      const decision = denialAuditCoalescer.shouldPersistRateLimited(rateLimitKey, now().getTime());
      shouldPersist = decision.persist;
      suppressedSincePersist = decision.suppressedSincePersist;
    }

    if (shouldPersist) {
      const entry: AuthzAuditEntry = {
        at: now().toISOString(),
        actorUserId: userId,
        organizationId: c.get("organizationId") ?? null,
        action: "admin:access",
        route: path,
        method,
        decision: "denied",
        reason: finalReason,
        ip: resolveNormalizedIp(c),
        userAgent: c.req.header("user-agent") ?? null,
        metadata: {
          platformRole: platformRole ?? null,
          allowedRoles,
          // Nunca 0 -- solo se agrega el campo cuando de verdad hubo
          // repeticiones suprimidas desde la última fila persistida de esta
          // misma llave (ver InMemoryDenialAuditCoalescer).
          ...(suppressedSincePersist > 0 ? { suppressedRateLimitedSincePersist: suppressedSincePersist } : {}),
        },
      };
      await options.audit.record(entry);
    }
    // `shouldPersist === false`: esta 429 se suprime EN LA CAPA DE
    // APLICACIÓN, antes de siquiera llamar a `options.audit.record` -- nunca
    // se abre la transacción de sistema del sink real
    // (`PersistentAuthzAuditSink::record` -> `engine.withAppSession`) para
    // una denegación que no aporta evidencia nueva sobre la ya persistida.

    if (!rl.allowed) {
      throw new ApiError(
        429,
        "rate_limited",
        "Demasiados intentos denegados a /admin desde este origen. Intenta más tarde.",
        { "retry-after": String(Math.ceil(rl.retryAfterMs / 1000)) },
      );
    }
    throw Errors.forbidden("No tienes permiso para acceder a esta sección de administración.");
  };
}
