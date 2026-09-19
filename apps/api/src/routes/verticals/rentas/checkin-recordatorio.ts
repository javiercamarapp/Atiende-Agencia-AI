// Fase 9 — GET/POST /internal/rentas/checkin-recordatorio: corrida periódica real
// del recordatorio de check-in (24-48h antes, ver
// @atiende/domain-rentas::runRecordatorioCheckInCore). Mismo patrón/guard EXACTO
// que apps/api/.../hoteles/email-dispatch.ts y .../citas/reminders.ts: acepta GET
// (Vercel Cron, que solo dispara GET con `Authorization: Bearer <CRON_SECRET>`) y
// POST (header manual `x-atiende-internal-secret`/tests), gateada por
// `internalOrCronSecretMatches` (ver comentario de cabecera de
// `http-security.ts::internalOrCronSecretMatches`).
import { Hono } from "hono";
import { runRecordatorioCheckInCore } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { triggerRentasEmailDispatchInline } from "./email-dispatch.ts";

export function rentasCheckInRecordatorioRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/checkin-recordatorio", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // Ruta interna de scheduler, sin authMiddleware/dbSession -- barre TODA la
    // plataforma (ver comentario de cabecera de checkin-reminders.ts: sin loop por
    // organización, cada ocupación se procesa independientemente), misma sesión de
    // sistema que ical-sync-cron.ts/email-dispatch.ts.
    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const rentasRepo = deps.rentasRepo(db);
      const summary = await runRecordatorioCheckInCore(rentasRepo);
      // Disparo inline best-effort (ver ./email-dispatch.ts::triggerRentasEmailDispatchInline):
      // el barrido de arriba pudo haber encolado recordatorios reales de
      // check-in vía `channel='email'` -- este cron es INDEPENDIENTE del cron
      // de `/internal/rentas/email-dispatch` (vercel.json los agenda por
      // separado), así que sin esto un correo podía esperar hasta 24h a que
      // corriera el OTRO cron.
      await triggerRentasEmailDispatchInline(deps, rentasRepo);
      return c.json({ ok: true, procesadas: summary.procesadas, enviados: summary.enviados, sin_correo: summary.sinCorreo, fallos: summary.fallos });
    });
  });

  return app;
}
