// Agregador de las 3 rutas Hono elegidas para Fase 1 del vertical rentas — mismo
// patrón de montaje que hotelesRoutes/restaurantesPublicRoutes en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { rentasReservasRoutes } from "./reservas.ts";
import { rentasCotizacionesRoutes } from "./cotizaciones.ts";
import { rentasFinanzasRoutes } from "./finanzas.ts";

export function rentasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", rentasReservasRoutes(deps));
  app.route("/", rentasCotizacionesRoutes(deps));
  app.route("/", rentasFinanzasRoutes(deps));
  return app;
}
