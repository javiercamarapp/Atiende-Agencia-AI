// Fase 5 -- GET/POST /internal/rentas/ical-sync: corrida periódica real del motor
// de sincronización iCal -- mismo patrón/guard EXACTO que
// apps/api/.../hoteles/email-dispatch.ts y .../citas/google-calendar-sync.ts:
// acepta GET (Vercel Cron, que solo dispara GET con
// `Authorization: Bearer <CRON_SECRET>`) y POST (header manual
// `x-atiende-internal-secret`/tests), gateada por `internalOrCronSecretMatches`
// (ver comentario de cabecera de `http-security.ts::internalOrCronSecretMatches`).
// Rn-01 -- lote idempotente con claim/lease por feed (varias instancias del cron no se
// pisan), backoff por feed fallido y bitácora/alertas: toda la orquestación vive en
// `ejecutarLoteSync` (@atiende/domain-rentas, src/sync/lote.ts). No está acotada por
// organización porque cada feed se procesa independientemente y un fallo de uno nunca
// debe detener a los demás. Contra una base sin la migración 024 el lote cae al
// barrido anterior (todos los feeds activos, sin lease).
//
// Wiring real del scheduler: `vercel.json::crons` invoca este mismo path por GET.
import { Hono } from "hono";
import { ejecutarLoteSync } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasIcalSyncCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/ical-sync", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/rentas/ical-sync", async () => {
      // `conSesionSistema` abre UNA transacción por llamada: el claim, cada feed, la
      // bitácora y la liberación del lease corren cada uno en la suya (ver lote.ts).
      const lote = await ejecutarLoteSync({
        conSesionSistema: (fn) => deps.engine.withAppSession({ userId: null }, fn),
        crearSyncRepo: (db) => deps.rentasCalendarSyncRepo(db),
        port: deps.rentasIcalFeedPort,
      });

      const resultados = lote.feeds.map((f) => ({
        feedId: f.feedId,
        unidadId: f.unidadId,
        canal: f.canal,
        resultado: f.resultado,
        eventosAplicados: f.eventosAplicados,
        conflictosDetectados: f.conflictosDetectados,
        ...(f.error !== undefined ? { error: f.error } : {}),
      }));
      const failures = resultados.filter((r) => "error" in r);
      const conflictos = resultados.reduce((acc, r) => acc + r.conflictosDetectados, 0);
      const response = c.json({ ok: failures.length === 0, modo: lote.modo, procesados: resultados.length, devueltosPorPresupuesto: lote.devueltosPorPresupuesto, conflictosDetectados: conflictos, resultados });
      if (failures.length > 0) {
        throw new CronPartialFailureError(`ical-sync: ${failures.length} de ${resultados.length} feeds fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
