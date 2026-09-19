// Bloque C del roadmap -- impersonación de soporte con bitácora, conectada a
// rutas reales. Cierra el hallazgo de la auditoría de 22 rubros:
// `packages/core-authz` trae `impersonation/*` y `admin-middleware.ts`
// construidos pero SIN conectar a ninguna ruta (verificado con `grep -rln`
// sobre `apps/` antes de empezar: cero imports).
//
// AUTORIZACIÓN: dos capas independientes, igual criterio que el resto del
// back office de plataforma (`superadmin.ts`/`superadmin-break-glass.ts`):
//   1. `requireAdminAccess` de `@atiende/core-authz` (admin-middleware, la
//      pieza que esta migración también conecta) -- audita CADA intento
//      denegado (`InMemoryAuditSink`) y aplica rate-limit real
//      (`InMemoryRateLimiter`) a los intentos denegados por actor+ruta.
//      MONTADO EN `routes/superadmin.ts`, NO aquí (ver el comentario largo de
//      ese archivo): Hono trata `app.use("/superadmin/*", mw)` como un
//      patrón que matchea TODA ruta bajo `/superadmin/` en la app compuesta,
//      no solo las de su propio archivo, y `superadmin.ts` se monta ANTES
//      que este router en `apps/api/src/app.ts` -- montar aquí una SEGUNDA
//      copia de `authMiddleware`/`requireAdminAccess` sería, en el mejor
//      caso, trabajo redundante (la primera copia ya decidió) y, en el peor
//      (como pasaba antes de esta corrección), código MUERTO: la rama de
//      denegación de la copia de este archivo nunca se ejecutaba porque la
//      de `superadmin.ts` ya había cortado la cadena con su propio 403
//      antes de llegar aquí -- verificado con un test que solo comprobaba el
//      status 403 sin distinguir qué middleware lo produjo. El
//      `platformRole` sintético ("owner" si `core.is_platform_superadmin`,
//      `undefined` si no) se resuelve una sola vez, en `superadmin.ts`.
//   2. Dentro de cada función SQL (`core.start_impersonation_session`/etc.,
//      ver `0020_superadmin_impersonacion.sql`): la autoridad REAL, nunca
//      confiada solo a esta capa.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  ImpersonationConflictError,
  ImpersonationForbiddenError,
  ImpersonationNotFoundError,
  ImpersonationReasonInvalidError,
  type ImpersonationAuditEntryRow,
  type ImpersonationSessionRow,
  type ImpersonationSessionWithActiveRow,
} from "@atiende/db";
import { Errors } from "../errors.ts";
import type { AppDeps } from "../deps.ts";

const MENSAJE_NO_MIGRADO = "La impersonación de superadmin todavía no está disponible en esta base (migración 0020 pendiente de aplicar).";

interface IniciarBody {
  readonly organizationId?: unknown;
  readonly reason?: unknown;
}

// `activa` para start/end/getActiveSession: estas 3 lecturas YA están
// filtradas en SQL a sesiones genuinamente vigentes (`expires_at > now()` Y
// sin evento `end`) -- `core.start_impersonation_session` acaba de crearla,
// `core.get_active_impersonation_session_for_superadmin` solo devuelve fila
// si sigue activa. `expiresAtMs > nowMs` aquí es un cálculo REDUNDANTE
// (siempre true para estas 3), nunca la fuente de verdad.
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

// GET /superadmin/impersonacion/sesiones (oversight de plataforma, TODAS las
// sesiones): a diferencia de `serializeSession` de arriba, aquí NO hay
// filtro SQL previo que garantice "vigente" -- la lista incluye sesiones ya
// terminadas o vencidas a propósito (es la bitácora de oversight). Por eso
// `active` viene YA calculado en SQL (`core.list_impersonation_sessions_for_
// superadmin`, ver la migración: `expires_at > now()` Y sin evento `end`) --
// nunca `expiresAtMs > Date.now()` en TS, que ignoraría un `end` explícito y
// mostraría "Activa" para una sesión ya cerrada hasta que expirara sola
// (bug real corregido en esta revisión, ver PR).
function serializeSessionListItem(s: ImpersonationSessionWithActiveRow) {
  return {
    id: s.id,
    organizationId: s.organizationId,
    reason: s.reason,
    actorEmail: s.actorEmail,
    startedAtMs: s.startedAtMs,
    expiresAtMs: s.expiresAtMs,
    activa: s.active,
    remainingMs: Math.max(0, s.expiresAtMs - Date.now()),
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

  // Autenticación + gateo de admin-middleware (audit-on-denial + rate-limit
  // reales) ya corrieron para CUALQUIER `/superadmin/*`, incluida esta ruta
  // -- ver el comentario de cabecera de este archivo y el de
  // `routes/superadmin.ts`. `c.get("userId")` ya está disponible aquí.

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
    return c.json({ available: true, sessions: result.sessions.map((s) => serializeSessionListItem(s)) });
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
