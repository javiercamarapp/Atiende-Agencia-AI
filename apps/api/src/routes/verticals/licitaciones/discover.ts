// Fase 8 — licitacionesDiscoverRoutes: expone por HTTP el job de ingesta
// automática real (`@atiende/worker::runDiscoverTendersSweep`) y el de
// recordatorios de plazo (`runDeadlineReminderSweep`). Rutas INTERNAS,
// gateadas por secreto compartido (`x-atiende-internal-secret` o
// `Authorization: Bearer`, ver `internalOrCronSecretMatches`, análogo a
// CRON_SECRET), pensadas para ser invocadas por un scheduler externo (Vercel
// Cron/Supabase Cron) — MISMO patrón EXACTO que
// `citasRemindersRoutes`/`hotelesNightAuditRoutes` (leídos primero como
// plantilla): sin `authMiddleware`/`dbSession`, abren su propia sesión de
// sistema (`userId: null`) para todo el barrido.
//
// Fase 12 (cierre del hallazgo ALTA "sin cron configurado") — `vercel.json`
// (raíz del repo) ya declara `crons` reales apuntando a estas 2 rutas. Vercel
// Cron dispara SIEMPRE con GET (no permite headers custom en la config), por
// eso cada ruta se registra con `app.on(["GET", "POST"], ...)`: GET es lo que
// el cron real usa, POST sigue funcionando igual que antes para curl/tests
// manuales — misma lógica, mismo gate de secreto, sin duplicar el handler.
//
// r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #2): YA NO
// se abre una única `withAppSession` para todo el barrido en ninguna de las 2 rutas
// -- `runDiscoverTendersSweep`/`runDeadlineReminderSweep` reciben un runner
// (`withRepo`) que abre UNA transacción por fuente/organización (ver su comentario de
// cabecera en @atiende/worker). Mismo patrón EXACTO que
// `../licitaciones/alertNotifications.ts` (leído primero como plantilla) --
// incluido el latido: antes, `ok:false` en el body nunca se reflejaba en el latido
// (`CronPartialFailureError` faltaba en estas 2 rutas, a diferencia de sus hermanas).
import { Hono } from "hono";
import { runDeadlineReminderSweep, runDiscoverTendersSweep } from "@atiende/worker";
import type { LicitacionesRepository } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesDiscoverRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/licitaciones/discover-tenders", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/licitaciones/discover-tenders", async () => {
      const withRepo = <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.licitacionesRepo(db)));
      const sweep = await runDiscoverTendersSweep(withRepo);
      const failures: { organization_id: string; source: string | null; error: string }[] = [];
      for (const orgResult of sweep) {
        if (orgResult.error) {
          failures.push({ organization_id: orgResult.organizationId, source: null, error: orgResult.error });
          continue;
        }
        for (const r of orgResult.results) {
          if (r.state !== "ok") failures.push({ organization_id: orgResult.organizationId, source: r.source, error: r.message });
        }
      }
      const response = c.json(
        {
          ok: failures.length === 0,
          organizations_checked: sweep.length,
          corridas: sweep.map((orgResult) => ({
            organization_id: orgResult.organizationId,
            error: orgResult.error ?? null,
            fuentes: orgResult.results.map((r) => ({ source: r.source, estado: r.state, descubiertos: r.discovered, creados: r.created, actualizados: r.updated, filas_descartadas: r.droppedRows, mensaje: r.message })),
          })),
          failures,
        },
        200,
      );
      // (5) el latido no debe registrar "ok" limpio si alguna fuente/organización
      // falló -- ver CronPartialFailureError (with-heartbeat.ts).
      if (failures.length > 0) {
        throw new CronPartialFailureError(`discover-tenders: ${failures.length} fallo(s) de ${sweep.length} organizaciones`, response);
      }
      return response;
    })();
  });

  app.on(["GET", "POST"], "/internal/licitaciones/deadline-reminders", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/licitaciones/deadline-reminders", async () => {
      const withRepo = <T>(fn: (repo: LicitacionesRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.licitacionesRepo(db)));
      const sweep = await runDeadlineReminderSweep(withRepo);
      const failures = sweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const scanned = sweep.reduce((sum, r) => sum + r.scanned, 0);
      const created = sweep.reduce((sum, r) => sum + r.created, 0);
      const response = c.json({ ok: failures.length === 0, organizations_checked: sweep.length, scanned, created, failures }, 200);
      if (failures.length > 0) {
        throw new CronPartialFailureError(`deadline-reminders: ${failures.length} de ${sweep.length} organizaciones fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
