// Cron `/internal/superadmin/mantenimiento` -- corre las DOS automatizaciones
// seguras del back office de plataforma (desatascar outbox colgado + marcar
// prospectos sin movimiento), envuelto en `withHeartbeat` (MISMO patrón que
// los otros handlers `/internal/*`, ver `../../salud/with-heartbeat.ts`).
// Cadencia diaria en `vercel.json` -- con un plan de Vercel que permita crons
// más frecuentes (el plan Hobby limita a 1 corrida/día por cron, ver
// https://vercel.com/docs/cron-jobs/usage-and-pricing), convendría correrlo
// cada 15-30 min (el umbral de "colgado" de la automatización es 30 min, así
// que una cadencia diaria deja rezagos reales entre que una fila se atasca y
// que este cron la libera -- documentado aquí a propósito, no escondido).
//
// Ambas automatizaciones son SOLO-SISTEMA (`auth.uid() is null`, ver
// `packages/db/migrations/0016_superadmin_acciones.sql`), idempotentes, y
// NUNCA envían nada por sí solas -- solo devuelven filas a `pending`/anotan
// un prospecto, dejando el trabajo real (enviar/decidir) a los dispatchers y
// al superadmin humano respectivamente.
import { Hono } from "hono";
import { Errors } from "../../errors.ts";
import { internalOrCronSecretMatches } from "../../http-security.ts";
import { withHeartbeat } from "../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../deps.ts";

/** Umbral de "colgado" para el desatasque de outbox -- MISMO valor que usa
 *  `ejecutar_mantenimiento_ahora` (ver `../superadmin-acciones.ts`), un solo
 *  número real en todo el sistema. */
const UMBRAL_OUTBOX_MINUTOS = 30;
/** Umbral de "sin movimiento" para marcar seguimiento -- MISMO valor que
 *  `ejecutar_mantenimiento_ahora`. */
const UMBRAL_PROSPECTOS_DIAS = 14;

/** Path EXACTO usado tanto en `vercel.json::crons` como en `withHeartbeat`. */
export const SUPERADMIN_MANTENIMIENTO_CRON_PATH = "/internal/superadmin/mantenimiento";

export function superadminMantenimientoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], SUPERADMIN_MANTENIMIENTO_CRON_PATH, async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, SUPERADMIN_MANTENIMIENTO_CRON_PATH, async () => {
      const [outbox, prospectos] = await Promise.all([
        deps.accionesRepo.desatascarOutboxColgadosForSystem(UMBRAL_OUTBOX_MINUTOS),
        deps.accionesRepo.marcarProspectosSinMovimientoForSystem(UMBRAL_PROSPECTOS_DIAS),
      ]);

      const filasDesatascadas = outbox.reduce((sum, q) => sum + (q.filasMovidas ?? 0), 0);
      return c.json({
        ok: true,
        outbox: outbox.map((q) => ({ queue: q.queueName, aplica: q.aplica, filasMovidas: q.filasMovidas, motivo: q.motivo })),
        filasDesatascadas,
        prospectosMarcados: prospectos.length,
      });
    })();
  });

  return app;
}
