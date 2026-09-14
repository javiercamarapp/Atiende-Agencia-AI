// Fase 3 §5 — POST/GET /internal/citas/google-calendar-sync: reconciliación por
// lote (mismo patrón/guard que reminders.ts). Recorre TODAS las citas de la
// plataforma con `google_sync_status in ('pending','pending_cancel')` cuyo
// backoff ya se cumplió — no está acotada por organización porque
// `syncPendingAppointments` ya pagina por lote (ver diseño §5/§8).
//
// §8 del diseño (Vercel Cron Hobby) — YA RESUELTO: `vercel.json::crons` invoca
// este mismo path por GET una vez al día (plan Hobby de Vercel solo permite
// frecuencia diaria; el propio backoff con reintentos de `syncPendingAppointments`
// ya tolera una cadencia de barrido espaciada) con `Authorization: Bearer
// <CRON_SECRET>`. `internalOrCronSecretMatches` acepta esa forma además del header
// manual `x-atiende-internal-secret` que ya usaban los tests/invocaciones
// manuales — mismo secreto (`INTERNAL_SECRET`), dos formas de mandarlo. Ídem
// para el recordatorio 24h (`apps/worker/src/jobs/citas/README.md`, ya
// actualizado).
import { Hono } from "hono";
import { syncPendingAppointments } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasGoogleCalendarSyncRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/citas/google-calendar-sync", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- misma sesión de
    // sistema que reminders.ts (barre TODA la plataforma, no una org concreta).
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const summary = await syncPendingAppointments(citasRepo, deps.citasGoogleCalendarPortResolver);
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
  });

  return app;
}
