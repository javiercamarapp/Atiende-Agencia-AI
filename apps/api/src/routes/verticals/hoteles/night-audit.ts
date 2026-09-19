// Fase 6 hoteles (REQ-REV-013, H15-018/H16-003/H07-032) — night audit propio,
// independiente del PMS del hotel. Dos superficies:
//
//   1. `POST /internal/hoteles/night-audit` — ruta interna de BARRIDO (todas las
//      properties de hoteles activas), gateada por `x-atiende-internal-secret`
//      (MISMO patrón que `apps/api/src/routes/verticals/citas/reminders.ts`, leído
//      primero como plantilla), pensada para ser invocada por un cron EXTERNO
//      (Vercel Cron/Supabase Cron) -- ver `apps/worker/src/jobs/hoteles/
//      night-audit.ts` para la decisión completa de mecanismo de invocación.
//   2. `POST/GET /hoteles/:propertyId/night-audit[...]` — disparo MANUAL de una sola
//      property (para forzar/ver el cierre desde /back-office) + consulta de
//      corridas ya hechas, protegido por NIGHT_AUDIT_ROLES (owner/gm/accountant,
//      mismo criterio que fraude/CFDI de Fase 5: dinero/conciliación).
//
// Ambas superficies llaman la MISMA lógica de orquestación
// (`runNightAuditForProperty`/`runNightAuditSweep`, @atiende/worker) -- ninguna ruta
// HTTP reimplementa el posteo de cargos/no-shows por su cuenta.
//
// Fase 6b (flujos de sistema, migrations/023_night_audit_sistema_escritura.sql): la
// ruta 1 corre bajo sesión de sistema (`withAppSession({ userId: null })`, sin
// `auth.uid()`) -- pasa `session: "sistema"` (vía `runNightAuditSweep`, que SIEMPRE
// corre en ese modo, ver su comentario de cabecera en @atiende/worker). La ruta 2
// corre bajo sesión de staff autenticado real -- pasa `session: "staff"`,
// LITERALMENTE el mismo comportamiento que antes de esta fase, sin ningún cambio.

import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { NIGHT_AUDIT_ROLES, type NightAuditSummary } from "@atiende/domain-hoteles";
import { runNightAuditForProperty, runNightAuditSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function serializeSummary(summary: NightAuditSummary) {
  return {
    fecha: summary.businessDate,
    cargosPosteados: summary.postedCharges,
    noShows: summary.noShows,
    anomalias: summary.anomalies,
    cargosPorConcepto: summary.cargosPorConcepto,
    pagosPorMetodo: summary.pagosPorMetodo,
    ocupacion: summary.ocupacion,
    conciliacionAB: summary.conciliacionAB,
    yaCompletado: summary.yaCompletado,
  };
}

export function hotelesNightAuditRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // ---- 1) Ruta interna de barrido — sin authMiddleware/dbSession, abre su propia
  //         sesión de sistema para todo el barrido (mismo patrón EXACTO que
  //         citasRemindersRoutes: `engine.withAppSession({ userId: null }, ...)`).
  //         `app.on(["GET","POST"], ...)`, NUNCA solo `app.post` — hallazgo de
  //         auditoría (ALTA, "night-audit nunca corre automáticamente"): Vercel Cron
  //         invoca el `path` configurado en vercel.json con GET (ver
  //         `citasRemindersRoutes`/`licitacionesDiscoverRoutes`/
  //         `hotelesEmailDispatchRoutes`, MISMO patrón exacto ya usado para las otras
  //         rutas internas de barrido de este monorepo) — con solo `app.post` aquí,
  //         agregar la entrada a `vercel.json` no habría bastado: el cron real
  //         seguiría recibiendo 404 en cada disparo. ----
  app.on(["GET", "POST"], "/internal/hoteles/night-audit", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/hoteles/night-audit", () => deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.hotelesRepo(db);
      const results = await runNightAuditSweep(repo);
      const failures = results.filter((r) => r.error != null);
      return c.json(
        {
          ok: failures.length === 0,
          properties_revisadas: results.length,
          corridas: results.map((r) => ({
            organizationId: r.organizationId,
            propertyId: r.propertyId,
            corrio: r.ran,
            razonOmitida: r.skippedReason ?? null,
            fecha: r.businessDate ?? null,
            error: r.error ?? null,
          })),
        },
        200,
      );
    }))();
  });

  // ---- 2) Disparo manual / consulta — mismo montaje doble que
  //         hotelesFraudeRoutes (Hono no matchea la ruta EXACTA con un `use(".../*")`
  //         solo, se necesitan ambas variantes). ----
  app.use("/hoteles/:propertyId/night-audit/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/hoteles/:propertyId/night-audit", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/hoteles/:propertyId/night-audit", async (c) => {
    assertVerticalRole(c, NIGHT_AUDIT_ROLES);
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const repo = deps.hotelesRepo(c.get("db"));

    const raw = (await c.req.json().catch(() => ({}))) as { businessDate?: unknown };
    let businessDate = todayIso();
    if (raw.businessDate !== undefined) {
      if (typeof raw.businessDate !== "string" || !DATE_RE.test(raw.businessDate)) {
        throw Errors.validation("businessDate: formato esperado YYYY-MM-DD.");
      }
      businessDate = raw.businessDate;
    }

    const summary = await runNightAuditForProperty(repo, { organizationId, propertyId, businessDate, session: "staff" });
    return c.json(serializeSummary(summary), 200);
  });

  app.get("/hoteles/:propertyId/night-audit/:businessDate", async (c) => {
    assertVerticalRole(c, NIGHT_AUDIT_ROLES);
    const propertyId = c.req.param("propertyId");
    const businessDate = c.req.param("businessDate");
    if (!DATE_RE.test(businessDate)) throw Errors.validation("businessDate: formato esperado YYYY-MM-DD.");

    const repo = deps.hotelesRepo(c.get("db"));
    const run = await repo.findNightAuditRun(propertyId, businessDate);
    if (!run) throw Errors.notFound("No hay corrida de night audit para esa fecha todavía.");
    return c.json({ estado: run.status, completadoEn: run.completedAt, resumen: run.summary });
  });

  // H5 · historial reciente (para /back-office "cierre diario") -- últimas N corridas.
  app.get("/hoteles/:propertyId/night-audit", async (c) => {
    assertVerticalRole(c, NIGHT_AUDIT_ROLES);
    const repo = deps.hotelesRepo(c.get("db"));
    const runs = await repo.listNightAuditRuns(c.req.param("propertyId"));
    return c.json(runs.map((r) => ({ fecha: r.businessDate, estado: r.status, completadoEn: r.completedAt })));
  });

  return app;
}
