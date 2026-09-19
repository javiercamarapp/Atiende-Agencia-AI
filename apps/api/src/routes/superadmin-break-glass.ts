// "Romper cristal" (break-glass) de plataforma -- Fase 10b, cierra el gap señalado
// por la auditoría del 18-sep-2026 ("break-glass de superadmin construido pero
// desconectado de toda ruta HTTP", ver packages/domain-rentas/src/break-glass/*.ts
// y packages/domain-rentas/migrations/012_break_glass_audit.sql/
// 018_break_glass_wiring.sql).
//
// Mismo patrón EXACTO que superadmin.ts/superadmin-llm-usage.ts: `authMiddleware` +
// `requireSuperadmin` (defensa en profundidad, 403 explícito) -- la autoridad REAL
// vive en las funciones `security definer` que `apps/api` invoca SIEMPRE sobre la
// sesión del propio superadmin (`engine.withAppSession({ userId: callerId })`,
// PATRÓN del PR #127/`core-repository.ts`, NUNCA sesión de sistema). Además, las
// lecturas de datos de tenant exigen una `rentas.break_glass_session` VIGENTE (sin
// cerrar, sin vencer) para el mismo actor+organización -- verificado dos veces:
// aquí (para un 403 con mensaje claro, ver `obtenerAccesoActivoBreakGlass`) y
// DENTRO de `rentas.list_reservas_for_break_glass` (defensa en profundidad real,
// nunca confiada solo de esta capa).
import { Hono } from "hono";
import { authMiddleware } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  BreakGlassDurationInvalidError,
  BreakGlassOrganizationRequiredError,
  BreakGlassReasonRequiredError,
  BreakGlassSessionNotFoundError,
  abrirAccesoBreakGlass,
  cerrarAccesoBreakGlass,
  esSesionBreakGlassActiva,
  leerReservasTenantBreakGlass,
  listarAccesosBreakGlass,
  obtenerAccesoActivoBreakGlass,
} from "@atiende/domain-rentas";
import type { BreakGlassAuditEntry, BreakGlassSession } from "@atiende/domain-rentas";
import { rateLimit } from "@atiende/core-ratelimit";
import { Errors } from "../errors.ts";
import { requestActor } from "../http-security.ts";
import type { AppDeps } from "../deps.ts";

const BREAK_GLASS_RATE_LIMIT = { max: 20, windowMs: 5 * 60_000 } as const;

interface AbrirAccesoBody {
  readonly organizationId?: unknown;
  readonly reason?: unknown;
  readonly durationMinutes?: unknown;
}

function serializeSession(s: BreakGlassSession, nowMs: number = Date.now()) {
  return {
    id: s.id,
    organizationId: s.organizationId,
    reason: s.reason,
    openedAtMs: s.openedAtMs,
    expiresAtMs: s.expiresAtMs,
    closedAtMs: s.closedAtMs,
    closedBy: s.closedBy,
    activa: esSesionBreakGlassActiva(s, nowMs),
    remainingMs: Math.max(0, s.expiresAtMs - nowMs),
  };
}

function serializeAuditEntry(e: BreakGlassAuditEntry) {
  return {
    id: e.id,
    organizationId: e.organizationId,
    reason: e.reason,
    resourceType: e.resourceType,
    resourceScope: e.resourceScope,
    resultSummary: e.resultSummary,
    occurredAtMs: e.occurredAtMs,
    seq: e.seq,
    hash: e.hash,
  };
}

export function superadminBreakGlassRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/superadmin/break-glass/*", authMiddleware(deps.env));
  app.use("/superadmin/break-glass/*", async (c, next) => {
    if (!(await deps.coreRepo.isPlatformSuperadmin(c.get("userId")))) {
      throw Errors.forbidden("El acceso de romper-cristal es exclusivo del back office de plataforma.");
    }
    await next();
  });
  // Rate-limit compartido por TODA la superficie de break-glass, categoría "admin"
  // de packages/core-ratelimit/src/endpoint-policy.ts (fail-closed -- "superficie
  // de operador con privilegios elevados"): abrir/cerrar/listar/leer cuentan contra
  // el MISMO presupuesto por superadmin -- un solo lugar, en vez de repetir la
  // llamada en cada handler.
  app.use("/superadmin/break-glass/*", async (c, next) => {
    const callerId = c.get("userId");
    const allowed = await rateLimit(`admin:break-glass:${requestActor(c.req.raw, callerId)}`, BREAK_GLASS_RATE_LIMIT.max, BREAK_GLASS_RATE_LIMIT.windowMs, {
      category: "admin",
    });
    if (!allowed) throw Errors.tooManyRequests("Demasiadas operaciones de romper-cristal en poco tiempo.");
    await next();
  });

  // Abrir un acceso de emergencia -- organización objetivo + motivo obligatorio +
  // duración acotada (5-240 minutos, ver BREAK_GLASS_MIN/MAX_DURATION_MINUTES).
  app.post("/superadmin/break-glass/sesiones", async (c) => {
    const callerId = c.get("userId");
    const raw = (await c.req.json().catch(() => ({}))) as AbrirAccesoBody;
    const organizationId = typeof raw.organizationId === "string" ? raw.organizationId.trim() : "";
    const reason = typeof raw.reason === "string" ? raw.reason : "";
    const durationMinutes = typeof raw.durationMinutes === "number" ? raw.durationMinutes : NaN;

    try {
      const session = await deps.engine.withAppSession({ userId: callerId }, (db) =>
        abrirAccesoBreakGlass(deps.rentasBreakGlassSessionRepo(db), {
          actor: { userId: callerId, email: c.get("userEmail") },
          organizationId,
          reason,
          durationMinutes,
        }),
      );
      return c.json({ session: serializeSession(session) }, 201);
    } catch (err) {
      if (err instanceof BreakGlassReasonRequiredError || err instanceof BreakGlassDurationInvalidError) throw Errors.validation(err.message);
      if (err instanceof BreakGlassOrganizationRequiredError) throw Errors.validation(err.message);
      throw err;
    }
  });

  // Listar accesos propios -- activos E históricos (nunca solo los vigentes: el
  // requisito explícito del gap).
  app.get("/superadmin/break-glass/sesiones", async (c) => {
    const callerId = c.get("userId");
    const sessions = await deps.engine.withAppSession({ userId: callerId }, (db) =>
      listarAccesosBreakGlass(deps.rentasBreakGlassSessionRepo(db), { userId: callerId, email: c.get("userEmail") }),
    );
    return c.json({ sessions: sessions.map((s) => serializeSession(s)) });
  });

  // Cerrar manualmente un acceso propio y todavía abierto.
  app.post("/superadmin/break-glass/sesiones/:id/cerrar", async (c) => {
    const callerId = c.get("userId");
    try {
      const session = await deps.engine.withAppSession({ userId: callerId }, (db) =>
        cerrarAccesoBreakGlass(deps.rentasBreakGlassSessionRepo(db), { userId: callerId, email: c.get("userEmail") }, c.req.param("id")),
      );
      return c.json({ session: serializeSession(session) });
    } catch (err) {
      if (err instanceof BreakGlassSessionNotFoundError) throw Errors.notFound(err.message);
      throw err;
    }
  });

  // Bitácora inmutable de lecturas propias (ver 012_break_glass_audit.sql) --
  // "vista de la bitácora" que pide la pantalla /superadmin/break-glass.
  app.get("/superadmin/break-glass/bitacora", async (c) => {
    const callerId = c.get("userId");
    const entries = await deps.engine.withAppSession({ userId: callerId }, (db) => deps.rentasBreakGlassAuditRepo(db).listForActor(callerId));
    return c.json({ entries: entries.map(serializeAuditEntry) });
  });

  // Lectura de datos de tenant bajo break-glass -- la ÚNICA categoría de dato que
  // este mecanismo sabe servir hoy (`resourceType: "reservas"`, ver el comentario
  // de cabecera de BreakGlassReservaResumen en tipos.ts). SOLO mientras haya un
  // acceso activo y vigente del propio superadmin para esta organización -- sin
  // eso, 403 explícito ANTES de intentar la lectura (defensa en profundidad: la
  // función SQL lo exige de nuevo, nunca confiada solo de este chequeo TS). Cada
  // lectura exitosa queda registrada en la bitácora inmutable dentro de
  // `leerReservasTenantBreakGlass` (fail-closed: si el registro de auditoría
  // falla, los datos ya leídos NUNCA llegan al llamador).
  app.get("/superadmin/break-glass/organizaciones/:organizationId/reservas", async (c) => {
    const callerId = c.get("userId");
    const organizationId = c.req.param("organizationId");
    const reason = c.req.query("reason") ?? "";

    return deps.engine.withAppSession({ userId: callerId }, async (db) => {
      const actor = { userId: callerId, email: c.get("userEmail") };
      const sesionActiva = await obtenerAccesoActivoBreakGlass(deps.rentasBreakGlassSessionRepo(db), callerId, organizationId);
      if (!sesionActiva) {
        throw Errors.forbidden("Sin acceso de romper-cristal activo y vigente para esta organización -- abre uno antes de leer datos del tenant.");
      }

      try {
        const { data } = await leerReservasTenantBreakGlass(deps.rentasBreakGlassAuditRepo(db), deps.rentasBreakGlassDataRepo(db), {
          actor,
          organizationId,
          reason: reason || sesionActiva.reason,
        });
        return c.json({ reservas: data });
      } catch (err) {
        if (err instanceof BreakGlassReasonRequiredError) throw Errors.validation(err.message);
        throw err;
      }
    });
  });

  return app;
}
