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
import type { RentasRepository } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { triggerRentasEmailDispatchInline } from "./email-dispatch.ts";

export function rentasCheckInRecordatorioRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/checkin-recordatorio", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // r4-fix-crons-transaccion-por-unidad (corrección de PR #163, bloqueante #1): YA
    // NO se abre una única `withAppSession` para todo el barrido -- barre TODA la
    // plataforma (ver comentario de cabecera de checkin-reminders.ts), pero
    // `runRecordatorioCheckInCore` recibe un runner (`withRepo`) que abre UNA
    // transacción POR candidata (ver su comentario de cabecera en @atiende/domain-rentas).
    return withHeartbeat(deps, "/internal/rentas/checkin-recordatorio", async () => {
      const withRepo = <T>(fn: (repo: RentasRepository) => Promise<T>) => deps.engine.withAppSession({ userId: null }, (db) => fn(deps.rentasRepo(db)));
      const summary = await runRecordatorioCheckInCore(withRepo);
      // Disparo inline best-effort (ver ./email-dispatch.ts::triggerRentasEmailDispatchInline):
      // el barrido de arriba pudo haber encolado recordatorios reales de
      // check-in vía `channel='email'` -- este cron es INDEPENDIENTE del cron
      // de `/internal/rentas/email-dispatch` (vercel.json los agenda por
      // separado), así que sin esto un correo podía esperar hasta 24h a que
      // corriera el OTRO cron. r4-fix-crons-transaccion-por-unidad: antes compartía
      // LA MISMA transacción del barrido completo; ahora abre la suya propia --
      // mismo criterio que `runRentasEmailDispatch` (el cron separado de
      // email-dispatch, que siempre abrió la suya).
      await withRepo((repo) => triggerRentasEmailDispatchInline(deps, repo));
      const response = c.json({ ok: summary.fallos === 0, procesadas: summary.procesadas, enviados: summary.enviados, sin_correo: summary.sinCorreo, fallos: summary.fallos });
      // (5) el latido no debe registrar "ok" limpio si alguna candidata falló --
      // ver CronPartialFailureError (with-heartbeat.ts). El caller HTTP sigue
      // recibiendo el 200 + detalle de arriba, nunca un 500.
      if (summary.fallos > 0) {
        throw new CronPartialFailureError(`checkin-recordatorio: ${summary.fallos} de ${summary.procesadas} candidatas fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
