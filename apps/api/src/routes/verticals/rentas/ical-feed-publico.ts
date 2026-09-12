// Fase 5 -- GET /rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed.ics:
// exportación PÚBLICA del feed iCal de disponibilidad de una unidad, para que
// Airbnb/Booking/VRBO/etc. importen la disponibilidad real de rentas. SIN
// authMiddleware/dbSession de staff a propósito -- un feed iCal de canal es SIEMPRE
// una URL pública sin autenticación (así es como cualquier plataforma de renta
// vacacional expone su calendario de disponibilidad hoy en la práctica: es
// información de disponibilidad -- qué noches están ocupadas--, nunca información de
// negocio sensible como nombre de huésped, precio o datos de contacto; ver
// domain-rentas/src/ical/exportador.ts, "nunca con datos de huésped"). Mismo criterio
// de sesión "de sistema" que las rutas públicas de citas/restaurantes
// (`engine.withAppSession({ userId: null }, ...)`), nunca `requirePropertyMembership`.
//
// `:canalCodigo` es parte de la ruta (no un query param) para que cada canal reciba su
// propio feed con su propia numeración de SEQUENCE y bookkeeping de anti-eco (ver
// domain-rentas/src/sync/motor.ts::exportarFeedParaUnidad) -- prácticas reales de PMS
// generan un enlace de exportación distinto por plataforma exactamente por esta razón
// (reconciliación/anti-eco por canal), aunque el contenido de disponibilidad sea
// equivalente.
import { Hono } from "hono";
import { exportarFeedParaUnidad } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasIcalFeedPublicoRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/rentas/:propertyId/unidades/:unidadId/canales/:canalCodigo/feed.ics", async (c) => {
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const canalCodigo = c.req.param("canalCodigo");

    return deps.engine.withAppSession({ userId: null }, async (db) => {
      const rentasRepo = deps.rentasRepo(db);
      const unidad = await rentasRepo.findUnidad(propertyId, unidadId);
      if (!unidad) throw Errors.notFound("Unidad no encontrada.");
      const canal = await rentasRepo.findCanalPorCodigo(canalCodigo);
      if (!canal) throw Errors.notFound(`Canal "${canalCodigo}" no reconocido.`);

      const syncRepo = deps.rentasCalendarSyncRepo(db);
      const feed = await exportarFeedParaUnidad({ syncRepo, organizationId: unidad.organizationId, propertyId, unidadId, canalId: canal.id }, `Disponibilidad — ${unidadId}`);

      c.header("Content-Type", "text/calendar; charset=utf-8");
      c.header("Cache-Control", "public, max-age=300"); // 5 min: suficiente para no recomputar en cada poll de un canal, sin quedar obsoleto por mucho tiempo.
      return c.body(feed.contenidoIcs);
    });
  });

  return app;
}
