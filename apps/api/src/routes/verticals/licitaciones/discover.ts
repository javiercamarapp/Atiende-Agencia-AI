// Fase 8 — licitacionesDiscoverRoutes: expone por HTTP el job de ingesta
// automática real (`@atiende/worker::runDiscoverTendersSweep`) y el de
// recordatorios de plazo (`runDeadlineReminderSweep`). Rutas INTERNAS,
// gateadas por secreto compartido (`x-atiende-internal-secret`, análogo a
// CRON_SECRET), pensadas para ser invocadas por un scheduler externo (Vercel
// Cron/Supabase Cron) — MISMO patrón EXACTO que
// `citasRemindersRoutes`/`hotelesNightAuditRoutes` (leídos primero como
// plantilla): sin `authMiddleware`/`dbSession`, abren su propia sesión de
// sistema (`userId: null`) para todo el barrido.
import { Hono } from "hono";
import { runDeadlineReminderSweep, runDiscoverTendersSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesDiscoverRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/licitaciones/discover-tenders", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.licitacionesRepo(db);
      const sweep = await runDiscoverTendersSweep(repo);
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
      return c.json(
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
    });
  });

  app.post("/internal/licitaciones/deadline-reminders", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.licitacionesRepo(db);
      const sweep = await runDeadlineReminderSweep(repo);
      const failures = sweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const scanned = sweep.reduce((sum, r) => sum + r.scanned, 0);
      const created = sweep.reduce((sum, r) => sum + r.created, 0);
      return c.json({ ok: failures.length === 0, organizations_checked: sweep.length, scanned, created, failures }, 200);
    });
  });

  return app;
}
