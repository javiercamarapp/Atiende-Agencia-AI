// R2 · GET /rentas/:propertyId/unidades/:unidadId/cotizacion — motor de cotización
// determinista (multi-moneda POR PROPIEDAD, nunca conversión de tipo de cambio — ver
// diseño Fase 1 rentas §1-#4). Reemplazo honesto del "cálculo de depósito/garantía"
// que no existe en el repo origen: el riesgo real de cara al huésped en rentas es
// mostrar un precio incorrecto. Mismo patrón que hoteles/quotes.ts: SOLO lectura,
// ninguna escritura de precio, el body/query NUNCA acepta un campo de precio/total.
import { Hono } from "hono";
import { authMiddleware, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { calcularCotizacion, esRangoValido } from "@atiende/domain-rentas";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function rentasCotizacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  const path = "/rentas/:propertyId/unidades/:unidadId/cotizacion";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  // Sin restricción de verticalRole más allá de requirePropertyMembership —
  // cualquier staff con acceso a la property puede cotizar (igual que hoteles).
  app.get(path, async (c) => {
    const propertyId = c.req.param("propertyId");
    const unidadId = c.req.param("unidadId");
    const checkIn = c.req.query("checkIn");
    const checkOut = c.req.query("checkOut");
    const canal = c.req.query("canal");
    const repo = deps.rentasRepo(c.get("db"));

    if (!checkIn || !DATE_RE.test(checkIn)) throw Errors.validation("checkIn: formato de fecha esperado YYYY-MM-DD.");
    if (!checkOut || !DATE_RE.test(checkOut)) throw Errors.validation("checkOut: formato de fecha esperado YYYY-MM-DD.");
    const rango = { inicio: checkIn, fin: checkOut };
    if (!esRangoValido(rango)) throw Errors.validation("checkOut debe ser posterior a checkIn.");

    // Un solo 404 para "unidad no encontrada" y "unidad sin tarifa base
    // configurada" — no distingue los dos casos, para no filtrar existencia (mismo
    // criterio que hoteles/quotes.ts).
    const contexto = await repo.loadPricingContext(propertyId, unidadId);
    if (!contexto) throw Errors.notFound("Unidad no encontrada en esta property, o sin tarifa base configurada.");

    const reglaCanal = canal ? await repo.loadReglaCanalPricing(unidadId, canal) : null;

    try {
      const cotizacion = calcularCotizacion({ contexto, rango, reglaCanal });
      return c.json(cotizacion, 200);
    } catch (err) {
      if (err instanceof Error) throw Errors.validation(err.message);
      throw err;
    }
  });

  return app;
}
