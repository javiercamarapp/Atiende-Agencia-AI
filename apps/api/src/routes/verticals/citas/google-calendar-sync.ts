// Fase 3 §5 — POST /internal/citas/google-calendar-sync: reconciliación por lote
// (el cron real, mismo patrón/guard que reminders.ts — header
// x-atiende-internal-secret, pensada para un scheduler externo). Recorre TODAS las
// citas de la plataforma con `google_sync_status in ('pending','pending_cancel')`
// cuyo backoff ya se cumplió — no está acotada por organización porque
// `syncPendingAppointments` ya pagina por lote (ver diseño §5/§8).
//
// §8 del diseño (Vercel Cron Hobby): quién dispara este endpoint y cada cuánto es
// una decisión de infraestructura pendiente, igual que ya es cierto hoy para el
// recordatorio 24h (`apps/worker/src/jobs/citas/README.md`) — este archivo solo
// construye el endpoint real, no el scheduler.
import { Hono } from "hono";
import { syncPendingAppointments } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasGoogleCalendarSyncRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/citas/google-calendar-sync", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    const summary = await syncPendingAppointments(deps.citasRepo, deps.citasGoogleCalendarPortResolver);
    return c.json({
      ok: true,
      processed: summary.processed,
      synced: summary.synced,
      retried: summary.retried,
      exhausted: summary.exhausted,
      skipped: summary.skipped,
      errors: summary.errors.map((e) => ({ appointment_id: e.appointmentId, error: e.error })),
    });
  });

  return app;
}
