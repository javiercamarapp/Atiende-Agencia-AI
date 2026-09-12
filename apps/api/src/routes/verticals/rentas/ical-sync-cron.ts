// Fase 5 -- POST /internal/rentas/ical-sync: corrida periódica real del motor de
// sincronización iCal -- mismo patrón/guard EXACTO que
// apps/api/.../citas/google-calendar-sync.ts (header x-atiende-internal-secret,
// pensada para un scheduler externo). Recorre TODOS los feeds activos de la
// plataforma (`rentas.canal_feed_externo.activo`), no está acotada por organización
// porque cada feed se procesa independientemente y un fallo de uno nunca debe
// detener a los demás.
//
// Quién dispara este endpoint y cada cuánto es una decisión de infraestructura
// pendiente (igual que el cron de citas) -- este archivo solo construye el endpoint
// real, no el scheduler.
import { Hono } from "hono";
import { ejecutarCicloImportacion } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import { secretMatches } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasIcalSyncCronRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.post("/internal/rentas/ical-sync", async (c) => {
    if (!secretMatches(c.req.raw, "x-atiende-internal-secret", deps.env.internalSecret)) throw Errors.unauthorized();

    return deps.engine.withAppSession({ userId: null }, async (db) => {
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
    });
  });

  return app;
}
