// GET/POST /internal/rentas/checkout-sweep -- barrido periodico (cada 15 minutos) de la limpieza de rentas:
// `barrerLimpiezaPendiente` (packages/domain-rentas/src/limpieza/aplicacion/tareas.ts). Desde paridad3 la tarea de
// limpieza nace AL CONFIRMAR la reserva (gancho de `crearReservaConfirmada`, tambien en el motor iCal); este barrido es
// la RED DE SEGURIDAD y ademas:
//   * crea la tarea de las reservas que no la tienen cuyo checkout ya llego en la zona horaria de SU propiedad, con tope
//     por propiedad (una organizacion con 120 salidas atrasadas no deja sin turno a las demas) y cada reserva aislada por
//     SAVEPOINT (una fila venenosa no aborta la transaccion de sistema);
//   * materializa el bloqueo BUFFER_LIMPIEZA el dia del checkout, cancela las tareas de reservas canceladas y reprograma
//     las desfasadas de su reserva;
//   * emite los avisos in-app: drena la cola de asignaciones (`rentas.limpieza.tarea_asignada`) y avisa de las tareas de
//     MAÑANA sin responsable pasadas las 18:00 locales (`rentas.limpieza.sin_asignar`) -- ver ./limpieza-avisos.ts.
// El comentario anterior de este archivo describia un "bloqueador conocido" (RLS filtraba en silencio las filas bajo la sesion
// de sistema): lo resolvio la migracion 015 (`auth.uid() is null` en las politicas de ocupacion/tarea/configuracion/unidad), y
// lo demuestra scripts/verify-rentas-cron-rls y scripts/verify-rentas-limpieza-autopiloto contra Postgres real.
//
// Mismo patron/guard que ical-sync-cron.ts: acepta GET (Vercel Cron, `Authorization: Bearer <CRON_SECRET>`) y POST (header
// manual `x-atiende-internal-secret`/tests), gateada por `internalOrCronSecretMatches`. Ruta de scheduler, sin
// authMiddleware/dbSession; el kill switch de plataforma (`platform-switches.ts`) lo aplica `withHeartbeat`. Idempotente: nunca
// crea una segunda tarea de limpieza para la misma reserva.
//
// Wiring real del scheduler: `vercel.json::crons` invoca este mismo path por GET cada 15 minutos.
import { Hono } from "hono";
import { barrerLimpiezaPendiente } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";
import { avisarSinAsignarManana, drenarAvisosAsignacion } from "./limpieza-avisos.ts";

/** Tope de tareas nuevas por corrida entre TODAS las propiedades y por propiedad (15 minutos: 4 corridas por hora). */
const LIMITE_TOTAL_POR_CORRIDA = 200;
const LIMITE_POR_PROPIEDAD = 40;

export function rentasCheckoutSweepCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/checkout-sweep", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/rentas/checkout-sweep", async () => {
      // UNA transaccion de sistema por corrida: cada reserva ya va aislada por SAVEPOINT dentro del barrido, asi que una fila
      // venenosa no revierte a las demas. El error parcial (latido) se lanza DESPUES de cerrar la transaccion, nunca dentro
      // de ella: lanzar ahi revertiria las tareas que si se crearon.
      const { resultado, asignacion, avisosSinAsignar } = await deps.engine.withAppSession({ userId: null }, async (db) => {
        const barrido = await barrerLimpiezaPendiente(db, { limiteTotal: LIMITE_TOTAL_POR_CORRIDA, limitePorPropiedad: LIMITE_POR_PROPIEDAD });
        // Avisos in-app (best-effort, cada emision dentro de su SAVEPOINT): nunca cambian el resultado del barrido.
        return { resultado: barrido, asignacion: await drenarAvisosAsignacion(db), avisosSinAsignar: await avisarSinAsignarManana(db, barrido.sinAsignarManana) };
      });
      const respuesta = c.json({
        ok: resultado.fallidos === 0,
        procesados: resultado.procesados,
        tareasCreadas: resultado.tareasCreadas,
        buffersCreados: resultado.buffersCreados,
        tareasCanceladas: resultado.tareasCanceladas,
        tareasReprogramadas: resultado.tareasReprogramadas,
        fallidos: resultado.fallidos,
        avisosAsignacion: asignacion.emitidos,
        avisosSinAsignar,
      });
      // El latido no debe mentir: una reserva que fallo queda visible como error, pero Vercel Cron no reintenta (devuelve 200).
      if (resultado.fallidos > 0) throw new CronPartialFailureError(`checkout-sweep: ${resultado.fallidos} reserva(s)/tarea(s) fallaron`, respuesta);
      return respuesta;
    })();
  });

  return app;
}
