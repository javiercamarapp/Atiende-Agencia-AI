// Fase 5 -- GET/POST /internal/rentas/ical-sync: corrida periódica real del motor
// de sincronización iCal -- mismo patrón/guard EXACTO que
// apps/api/.../hoteles/email-dispatch.ts y .../citas/google-calendar-sync.ts:
// acepta GET (Vercel Cron, que solo dispara GET con
// `Authorization: Bearer <CRON_SECRET>`) y POST (header manual
// `x-atiende-internal-secret`/tests), gateada por `internalOrCronSecretMatches`
// (ver comentario de cabecera de `http-security.ts::internalOrCronSecretMatches`).
// Recorre TODOS los feeds activos de la plataforma
// (`rentas.canal_feed_externo.activo`), no está acotada por organización porque
// cada feed se procesa independientemente y un fallo de uno nunca debe detener a
// los demás.
//
// Wiring real del scheduler: `vercel.json::crons` invoca este mismo path por GET.
import { Hono } from "hono";
import { ejecutarCicloImportacion } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { internalOrCronSecretMatches } from "../../../http-security.ts";
import { CronPartialFailureError, withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasIcalSyncCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/ical-sync", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    // r4-fix-crons-transaccion-por-unidad: mismo patrón exacto que hoteles/
    // night-audit -- YA NO se abre una única `withAppSession` para todo el
    // barrido de feeds. `listFeedsActivos()` corre en su propia transacción
    // corta, y CADA feed corre la suya (`db`/`syncRepo` van SIEMPRE juntos,
    // ligados a la MISMA sesión -- `ejecutarCicloImportacion` recibe ambos).
    return withHeartbeat(deps, "/internal/rentas/ical-sync", async () => {
      const feeds = await deps.engine.withAppSession({ userId: null }, (db) => deps.rentasCalendarSyncRepo(db).listFeedsActivos());

      const resultados: { feedId: string; unidadId: string; canal: string; resultado: string; eventosAplicados: number; error?: string }[] = [];
      for (const feed of feeds) {
        try {
          const resultado = await deps.engine.withAppSession({ userId: null }, async (db) => {
            const syncRepo = deps.rentasCalendarSyncRepo(db);
            const zonaHorariaPropiedad = await syncRepo.findZonaHorariaPropiedad(feed.propertyId);
            return ejecutarCicloImportacion({ db, syncRepo, port: deps.rentasIcalFeedPort, feed, zonaHorariaPropiedad });
          });
          resultados.push({ feedId: feed.id, unidadId: feed.unidadId, canal: feed.canalCodigo, resultado: resultado.resultado, eventosAplicados: resultado.eventosAplicados });
        } catch (err) {
          // Un fallo real de base de datos procesando UN feed nunca debe detener el
          // resto de la corrida -- mismo criterio que syncPendingAppointments de
          // domain-citas (un tenant/proveedor con datos raros nunca tumba la corrida
          // completa de los demás). r4-fix-crons-transaccion-por-unidad: antes esta
          // captura no aislaba nada real (transacción compartida con TODOS los
          // feeds); ahora cada feed tiene su propia transacción, así que este catch
          // SÍ corresponde a un ROLLBACK real de solo este feed.
          resultados.push({ feedId: feed.id, unidadId: feed.unidadId, canal: feed.canalCodigo, resultado: "error_interno", eventosAplicados: 0, error: err instanceof Error ? err.message.slice(0, 500) : "error desconocido" });
        }
      }

      const failures = resultados.filter((r) => r.error != null);
      // r4-fix-crons-transaccion-por-unidad: `ok` antes era SIEMPRE `true`
      // (ignoraba `resultado:"error_interno"` en el body) -- ahora refleja la
      // verdad, igual que los demás crons corregidos en este PR.
      const response = c.json({ ok: failures.length === 0, procesados: resultados.length, resultados });
      if (failures.length > 0) {
        throw new CronPartialFailureError(`ical-sync: ${failures.length} de ${resultados.length} feeds fallaron`, response);
      }
      return response;
    })();
  });

  return app;
}
