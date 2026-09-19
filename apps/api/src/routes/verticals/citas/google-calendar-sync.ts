// Fase 3 §5, generalizado en Fase 6 §2 (seguimiento) — POST/GET
// /internal/citas/google-calendar-sync: reconciliación por lote (mismo patrón/
// guard que reminders.ts). Recorre TODAS las citas de la plataforma con
// `google_sync_status in ('pending','pending_cancel')` cuyo backoff ya se
// cumplió — no está acotada por organización NI por plataforma de calendario:
// `syncPendingAppointmentsMultiProvider` despacha, cita por cita, a Google, Cal.com
// o CalDAV según cuál tenga conectado el proveedor de esa cita (ver
// @atiende/domain-citas::calendar-sync.ts/calendar-sync-resolver-factory.ts) — el
// nombre del path se conserva tal cual (`google-calendar-sync`, heredado de Fase
// 3) a propósito: renombrarlo es un cambio cosmético que obligaría a tocar
// `vercel.json` sin ganar nada funcional; el comportamiento real de este
// endpoint ya cubre las tres plataformas.
//
// §8 del diseño (Vercel Cron Hobby) — YA RESUELTO: `vercel.json::crons` invoca
// este mismo path por GET una vez al día (plan Hobby de Vercel solo permite
// frecuencia diaria; el propio backoff con reintentos de
// `syncPendingAppointmentsMultiProvider` ya tolera una cadencia de barrido
// espaciada) con `Authorization: Bearer <CRON_SECRET>`. `internalOrCronSecretMatches`
// acepta esa forma además del header manual `x-atiende-internal-secret` que ya
// usaban los tests/invocaciones manuales — mismo secreto (`INTERNAL_SECRET`), dos
// formas de mandarlo. Ídem para el recordatorio 24h
// (`apps/worker/src/jobs/citas/README.md`, ya actualizado).
import { Hono } from "hono";
import { syncPendingAppointmentsMultiProvider } from "@atiende/domain-citas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function citasGoogleCalendarSyncRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/citas/google-calendar-sync", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- misma sesión de
    // sistema que reminders.ts (barre TODA la plataforma, no una org concreta).
    return withHeartbeat(deps, "/internal/citas/google-calendar-sync", () => deps.engine.withAppSession({ userId: null }, async (db) => {
      const citasRepo = deps.citasRepo(db);
      const summary = await syncPendingAppointmentsMultiProvider(citasRepo, deps.citasCalendarSyncPortResolver);
      return c.json({
        ok: true,
        processed: summary.processed,
        synced: summary.synced,
        retried: summary.retried,
        exhausted: summary.exhausted,
        skipped: summary.skipped,
        errors: summary.errors.map((e) => ({ appointment_id: e.appointmentId, error: e.error })),
      });
    }))();
  });

  return app;
}
