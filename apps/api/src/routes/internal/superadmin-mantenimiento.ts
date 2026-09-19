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
import { isUndefinedFunctionError } from "@atiende/db";
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
      // `desatascarOutboxColgadosForSystem`/`marcarProspectosSinMovimientoForSystem`
      // (`../../production/superadmin-acciones-repository.ts::
      // ProductionSuperadminAccionesRepository`) abren cada una su PROPIA
      // transacción -- ninguna comparte transacción con la otra ni con nada más
      // en este handler, así que un catch simple alrededor del `Promise.all`
      // basta (sin SAVEPOINT): si la migración 0016 no está aplicada, NINGUNA
      // de las dos ejecutó nada real que necesite deshacerse.
      let outbox: Awaited<ReturnType<typeof deps.accionesRepo.desatascarOutboxColgadosForSystem>>;
      let prospectos: Awaited<ReturnType<typeof deps.accionesRepo.marcarProspectosSinMovimientoForSystem>>;
      try {
        [outbox, prospectos] = await Promise.all([
          deps.accionesRepo.desatascarOutboxColgadosForSystem(UMBRAL_OUTBOX_MINUTOS),
          deps.accionesRepo.marcarProspectosSinMovimientoForSystem(UMBRAL_PROSPECTOS_DIAS),
        ]);
      } catch (err) {
        // Mismo criterio que el cron de resumen diario (hallazgo B): "migración
        // pendiente" es el caso NORMAL de "código nuevo, base vieja" -- NUNCA un
        // fallo real de este cron. Se resuelve (no se lanza) a propósito: lanzar
        // aquí ensuciaría `core.cron_heartbeat` con `last_status='error'` vía
        // `withHeartbeat` y generaría alertas falsas en `/superadmin/salud` por
        // algo que no es un bug. Cualquier otro código de error se repropaga tal
        // cual.
        if (!isUndefinedFunctionError(err)) throw err;
        return c.json({ ok: false, motivo: "migracion_pendiente" });
      }

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
