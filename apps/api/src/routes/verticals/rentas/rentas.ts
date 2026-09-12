// Agregador de las rutas Hono del vertical rentas — 3 de Fase 1 + 3 de Fase 2 (pricing
// CRUD, owner statement, payout/conciliación) — mismo patrón de montaje que
// hotelesRoutes/restaurantesPublicRoutes en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { rentasReservasRoutes } from "./reservas.ts";
import { rentasCotizacionesRoutes } from "./cotizaciones.ts";
import { rentasFinanzasRoutes } from "./finanzas.ts";
import { rentasPricingConfigRoutes } from "./pricing-config.ts";
import { rentasFinanzasStatementsRoutes } from "./finanzas-statements.ts";
import { rentasFinanzasPayoutsRoutes } from "./finanzas-payouts.ts";

export function rentasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", rentasReservasRoutes(deps));
  app.route("/", rentasCotizacionesRoutes(deps));
  app.route("/", rentasFinanzasRoutes(deps));
  app.route("/", rentasPricingConfigRoutes(deps));
  app.route("/", rentasFinanzasStatementsRoutes(deps));
  app.route("/", rentasFinanzasPayoutsRoutes(deps));
  return app;
}
