// Fase 9 — POST /internal/rentas/checkin-recordatorio: corrida periódica real del
// recordatorio de check-in (24-48h antes, ver
// @atiende/domain-rentas::runRecordatorioCheckInCore). Mismo patrón/guard EXACTO
// que apps/api/.../citas/reminders.ts y .../rentas/ical-sync-cron.ts (header
// x-atiende-internal-secret, pensada para ser invocada por un scheduler externo —
// Vercel Cron / Supabase cron; quién la dispara y cada cuánto es una decisión de
// infraestructura pendiente, igual que el resto de crons internos de este
// monorepo).
import { Hono } from "hono";
import { runRecordatorioCheckInCore } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasCheckInRecordatorioRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/rentas/checkin-recordatorio", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (ver comentario de cabecera de checkin-reminders.ts: sin loop por
    // organización, cada ocupación se procesa independientemente), misma sesión de
    // sistema que ical-sync-cron.ts/email-dispatch.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const rentasRepo = deps.rentasRepo(db);
      const summary = await runRecordatorioCheckInCore(rentasRepo);
      return c.json({ ok: true, procesadas: summary.procesadas, enviados: summary.enviados, sin_correo: summary.sinCorreo, fallos: summary.fallos });
    });
  });

  return app;
}
