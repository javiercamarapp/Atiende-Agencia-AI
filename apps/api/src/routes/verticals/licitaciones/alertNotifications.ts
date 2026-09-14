// Fase 10 — licitacionesAlertNotificationsRoutes: expone por HTTP el barrido
// real de despacho proactivo de alertas
// (`@atiende/worker::runAlertNotificationSweep`) y el dispatcher de correo
// que de verdad drena `licitaciones.messaging_outbox` vía Resend
// (`@atiende/domain-licitaciones::dispatchPendingEmailJobs`). Rutas
// INTERNAS, gateadas por secreto compartido (`x-atiende-internal-secret`,
// análogo a CRON_SECRET), pensadas para ser invocadas por un scheduler
// externo (Vercel Cron/Supabase Cron) — MISMO patrón EXACTO que
// `./discover.ts` (recordatorios de plazo/ingesta, Fase 8) y
// `../rentas/email-dispatch.ts`/`../citas/email-dispatch.ts` (leídos primero
// como plantilla): sin `authMiddleware`/`dbSession`, abren su propia sesión
// de sistema (`userId: null`) para todo el barrido.
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-licitaciones";
import { runAlertNotificationSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesAlertNotificationsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/licitaciones/alert-notifications", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.licitacionesRepo(db);
      const sweep = await runAlertNotificationSweep(repo);
      const failures = sweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const totals = sweep.reduce(
        (acc, r) => ({
          deadline_reminders_created: acc.deadline_reminders_created + r.deadlineReminders.created,
          renewal_alerts_created: acc.renewal_alerts_created + r.renewalAlerts.alertsCreated,
          overdue_invoices: acc.overdue_invoices + r.collectionAlerts.overdueInvoices,
          emails_enqueued: acc.emails_enqueued + r.deadlineReminders.emailsEnqueued + r.renewalAlerts.emailsEnqueued + r.collectionAlerts.emailsEnqueued,
        }),
        { deadline_reminders_created: 0, renewal_alerts_created: 0, overdue_invoices: 0, emails_enqueued: 0 },
      );
      return c.json(
        {
          ok: failures.length === 0,
          organizations_checked: sweep.length,
          ...totals,
          corridas: sweep.map((r) => ({
            organization_id: r.organizationId,
            error: r.error ?? null,
            recordatorios_plazo: r.deadlineReminders,
            alertas_renovacion: r.renewalAlerts,
            alertas_cobranza: r.collectionAlerts,
          })),
          failures,
        },
        200,
      );
    });
  });

  app.post("/internal/licitaciones/email-dispatch", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que las demás rutas internas.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.licitacionesRepo(db);
      const summary = await dispatchPendingEmailJobs(repo, deps.env.resend);
      return c.json({
        ok: true,
        processed: summary.processed,
        sent: summary.sent,
        failed: summary.failed,
        dead: summary.dead,
        errors: summary.errors.map((e) => ({ job_id: e.jobId, error: e.error })),
      });
    });
  });

  return app;
}
