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
import { withHeartbeat } from "../../../salud/with-heartbeat.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasIcalSyncCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.on(["GET", "POST"], "/internal/rentas/ical-sync", async (c) => {
    if (!internalOrCronSecretMatches(c.req.raw, deps.env.internalSecret)) throw Errors.unauthorized();

    return withHeartbeat(deps, "/internal/rentas/ical-sync", () => deps.engine.withAppSession({ userId: null }, async (db) => {
      const syncRepo = deps.rentasCalendarSyncRepo(db);
      const feeds = await syncRepo.listFeedsActivos();

      const resultados: { feedId: string; unidadId: string; canal: string; resultado: string; eventosAplicados: number; error?: string }[] = [];
      for (const feed of feeds) {
        try {
          const zonaHorariaPropiedad = await syncRepo.findZonaHorariaPropiedad(feed.propertyId);
          const resumen = await ejecutarCicloImportacion({ db, syncRepo, port: deps.rentasIcalFeedPort, feed, zonaHorariaPropiedad });
          resultados.push({ feedId: feed.id, unidadId: feed.unidadId, canal: feed.canalCodigo, resultado: resumen.resultado, eventosAplicados: resumen.eventosAplicados });
        } catch (err) {
          // Un fallo real de base de datos procesando UN feed nunca debe detener el
          // resto de la corrida -- mismo criterio que syncPendingAppointments de
          // domain-citas (un tenant/proveedor con datos raros nunca tumba la corrida
          // completa de los demás).
          resultados.push({ feedId: feed.id, unidadId: feed.unidadId, canal: feed.canalCodigo, resultado: "error_interno", eventosAplicados: 0, error: err instanceof Error ? err.message.slice(0, 500) : "error desconocido" });
        }
      }

      return c.json({ ok: true, procesados: resultados.length, resultados });
    }))();
  });

  return app;
}
