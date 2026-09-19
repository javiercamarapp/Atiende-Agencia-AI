// Bloque C del roadmap -- impersonación de soporte con bitácora, conectada a
// rutas reales. Cierra el hallazgo de la auditoría de 22 rubros:
// `packages/core-authz` trae `impersonation/*` y `admin-middleware.ts`
// construidos pero SIN conectar a ninguna ruta (verificado con `grep -rln`
// sobre `apps/` antes de empezar: cero imports).
//
// AUTORIZACIÓN: dos capas independientes, igual criterio que el resto del
// back office de plataforma (`superadmin.ts`/`superadmin-break-glass.ts`):
//   1. Aquí: `requireAdminAccess` de `@atiende/core-authz` (admin-middleware,
//      la pieza que esta migración también conecta) -- audita CADA intento
//      denegado (`InMemoryAuditSink`) y aplica rate-limit real
//      (`InMemoryRateLimiter`) a los intentos denegados por actor+ruta. El
//      `platformRole` que lee es SINTÉTICO ("owner" si `core.is_platform_
//      superadmin`, `undefined` si no) -- `PlatformRole` de `@atiende/
//      core-tenancy` (owner/admin/member/viewer) es un rol DENTRO de una
//      organización; un superadmin de plataforma no pertenece a ninguna por
//      diseño, así que no hay un `PlatformRole` "real" que leer. Se documenta
//      aquí, en el PR y en `knownGaps`: `requireOrganizationMembership()` (la
//      variante que sí lee `core.membership`) NO se usa -- no aplica a este
//      actor.
//   2. Dentro de cada función SQL (`core.start_impersonation_session`/etc.,
//      ver `0020_superadmin_impersonacion.sql`): la autoridad REAL, nunca
//      confiada solo a esta capa.
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { InMemoryAuditSink, InMemoryRateLimiter, requireAdminAccess } from "@atiende/core-authz";
import {
  ImpersonationConflictError,
  ImpersonationForbiddenError,
  ImpersonationNotFoundError,
  ImpersonationReasonInvalidError,
  type ImpersonationAuditEntryRow,
  type ImpersonationSessionRow,
} from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

// Instancias por-proceso, compartidas por TODA la superficie de esta ruta --
// mismo criterio que `requireAdminAccess` documenta en su propio comentario
// de cabecera (un bucket/sink por actor+ruta, defensa en profundidad de UN
// proceso). 30 intentos denegados / 5 min por actor+ruta antes de 429.
const impersonacionAudit = new InMemoryAuditSink();
const impersonacionRateLimiter = new InMemoryRateLimiter({ capacity: 30, refillPerSecond: 30 / 300 });

const MENSAJE_NO_MIGRADO = "La impersonación de superadmin todavía no está disponible en esta base (migración 0020 pendiente de aplicar).";

interface IniciarBody {
  readonly organizationId?: unknown;
  readonly reason?: unknown;
}

function serializeSession(s: ImpersonationSessionRow, nowMs: number = Date.now()) {
  return {
    id: s.id,
    organizationId: s.organizationId,
    reason: s.reason,
    actorEmail: s.actorEmail,
    startedAtMs: s.startedAtMs,
    expiresAtMs: s.expiresAtMs,
    activa: s.expiresAtMs > nowMs,
    remainingMs: Math.max(0, s.expiresAtMs - nowMs),
  };
}

function serializeAuditEntry(e: ImpersonationAuditEntryRow) {
  return {
    id: e.id,
    sessionId: e.sessionId,
    eventType: e.eventType,
    organizationId: e.organizationId,
    actorEmail: e.actorEmail,
    reason: e.reason,
    detail: e.detail,
    occurredAtMs: e.occurredAtMs,
    seq: e.seq,
    hash: e.hash,
  };
}

export function superadminImpersonacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/impersonacion/*", authMiddleware(deps.env));
  app.use("/superadmin/impersonacion/*", async (c, next) => {
    const isSuperadmin = await deps.coreRepo.isPlatformSuperadmin(c.get("userId"));
    c.set("platformRole", isSuperadmin ? "owner" : undefined);
    await next();
  });
  app.use(
    "/superadmin/impersonacion/*",
    requireAdminAccess({
      allowedRoles: ["owner"],
      audit: impersonacionAudit,
      rateLimiter: impersonacionRateLimiter,
    }),
  );

  // Iniciar una sesión -- organización objetivo + motivo obligatorio (>=20
  // caracteres). Duración (15 min) y expiración SIEMPRE calculadas por
  // `core.start_impersonation_session`, nunca por el cliente.
  app.post("/superadmin/impersonacion/sesiones", async (c) => {
    const callerId = c.get("userId");
    const raw = (await c.req.json().catch(() => ({}))) as IniciarBody;
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId.trim() : "";
    const reason = typeof raw.reason === "string" ? raw.reason : "";

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).startSession(callerId, organizationId, reason));
      if (result.availability === "not_migrated") {
        throw Errors.serviceUnavailable(MENSAJE_NO_MIGRADO);
      }
      return c.json({ session: serializeSession(result.session!) }, 201);
    } catch (err) {
      if (err instanceof ImpersonationReasonInvalidError) throw Errors.validation(err.message);
      if (err instanceof ImpersonationNotFoundError) throw Errors.notFound(err.message);
      if (err instanceof ImpersonationForbiddenError) throw Errors.forbidden(err.message);
      if (err instanceof ImpersonationConflictError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  // Terminar una sesión propia y todavía activa -- ÚNICA escritura permitida
  // mientras hay una impersonación activa (ver `write-guard.ts` de
  // `@atiende/core-authz`: este endpoint es exactamente el caso que
  // `exemptPaths` está diseñado para declarar, aunque esta ruta en particular
  // no monta el guard porque no hay OTRA escritura en esta superficie que
  // proteger -- el guard real se conecta en `routes/superadmin.ts`, ver ese
  // archivo).
  app.post("/superadmin/impersonacion/sesiones/:id/terminar", async (c) => {
    const callerId = c.get("userId");
    const sessionId = c.req.param("id");

    try {
      const result = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).endSession(callerId, sessionId));
      if (result.availability === "not_migrated") {
        throw Errors.serviceUnavailable(MENSAJE_NO_MIGRADO);
      }
      return c.json({ entry: serializeAuditEntry(result.entry!) });
    } catch (err) {
      if (err instanceof ImpersonationNotFoundError) throw Errors.notFound(err.message);
      if (err instanceof ImpersonationForbiddenError) throw Errors.forbidden(err.message);
      if (err instanceof ImpersonationConflictError) throw Errors.conflict(err.message);
      throw err;
    }
  });

  // "¿Tengo YO una sesión activa ahora mismo?" -- la fuente de verdad real
  // (SQL, no una cookie con TTL de aplicación) para el banner permanente de
  // la UI.
  app.get("/superadmin/impersonacion/activa", async (c) => {
    const callerId = c.get("userId");
    const result = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).getActiveSession(callerId));
    if (result.availability === "not_migrated") {
      return c.json({ available: false, session: null });
    }
    return c.json({ available: true, session: result.session ? serializeSession(result.session) : null });
  });

  // Bitácora + sesiones -- oversight de plataforma (cualquier superadmin
  // vigente ve TODAS las sesiones/eventos, no solo los propios -- ver policy
  // de RLS en la migración).
  app.get("/superadmin/impersonacion/sesiones", async (c) => {
    const callerId = c.get("userId");
    const result = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).listSessions(callerId));
    if (result.availability === "not_migrated") {
      return c.json({ available: false, sessions: [] });
    }
    return c.json({ available: true, sessions: result.sessions.map((s) => serializeSession(s)) });
  });

  app.get("/superadmin/impersonacion/bitacora", async (c) => {
    const callerId = c.get("userId");
    const result = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.impersonationRepo(db).listAuditLog(callerId));
    if (result.availability === "not_migrated") {
      return c.json({ available: false, entries: [] });
    }
    return c.json({ available: true, entries: result.entries.map(serializeAuditEntry) });
  });

  return app;
}
