// despachosNotificationsRoutes — hallazgo de auditoría (severidad ALTA):
// "Despachos no tiene ninguna infraestructura de correo (ni outbox, ni
// plantilla HTML, ni dispatch), mientras citas/rentas/licitaciones sí la
// tienen". Expone por HTTP el barrido real de recordatorios de cobranza
// (`@atiende/worker::runCobranzaReminderSweep`) y el dispatcher de correo que
// de verdad drena `despachos.messaging_outbox` vía Resend
// (`@atiende/domain-despachos::dispatchPendingEmailJobs`) — MISMO patrón
// EXACTO que `../licitaciones/alertNotifications.ts` (leído primero como
// plantilla, que a su vez cita `../rentas/email-dispatch.ts`/
// `../citas/email-dispatch.ts`): rutas INTERNAS, gateadas por secreto
// compartido (`x-atiende-internal-secret`), pensadas para ser invocadas por un
// scheduler externo (Vercel Cron/Supabase Cron) — sin `authMiddleware`/
// `dbSession`, abren su propia sesión de sistema (`userId: null`) para todo el
// barrido.
import { Hono } from "hono";
import { dispatchPendingEmailJobs } from "@atiende/domain-despachos";
import { runCobranzaReminderSweep } from "@atiende/worker";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function despachosNotificationsRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/despachos/cobranza-reminders", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.despachosRepo(db);
      const sweep = await runCobranzaReminderSweep(repo);
      const failures = sweep.filter((r) => r.error != null).map((r) => ({ organization_id: r.organizationId, error: r.error }));
      const totals = sweep.reduce(
        (acc, r) => {
          for (const p of r.properties) {
            acc.receivables_scanned += p.receivablesScanned;
            acc.reminders_due += p.remindersDue;
            acc.emails_enqueued += p.emailsEnqueued;
          }
          return acc;
        },
        { receivables_scanned: 0, reminders_due: 0, emails_enqueued: 0 },
      );
      return c.json(
        {
          ok: failures.length === 0,
          organizations_checked: sweep.length,
          ...totals,
          corridas: sweep.map((r) => ({
            organization_id: r.organizationId,
            error: r.error ?? null,
            properties: r.properties.map((p) => ({ property_id: p.propertyId, receivables_scanned: p.receivablesScanned, reminders_due: p.remindersDue, emails_enqueued: p.emailsEnqueued })),
          })),
          failures,
        },
        200,
      );
    });
  });

  app.post("/internal/despachos/email-dispatch", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (channel='email' del outbox no está particionado por
    // organización), misma sesión de sistema que las demás rutas internas.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const repo = deps.despachosRepo(db);
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
