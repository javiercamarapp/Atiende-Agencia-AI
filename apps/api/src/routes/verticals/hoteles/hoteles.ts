// Agregador de las 3 rutas Hono elegidas para Fase 1 del vertical hoteles — mismo
// patrón de montaje que restaurantesPublicRoutes/restaurantesWhatsAppRoutes en
// apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { hotelesFoliosRoutes } from "./folios.ts";
import { hotelesPedidosFnbRoutes } from "./pedidosFnb.ts";
import { hotelesQuotesRoutes } from "./quotes.ts";
import { hotelesReservasRoutes } from "./reservas.ts";

export function hotelesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", hotelesFoliosRoutes(deps));
  app.route("/", hotelesPedidosFnbRoutes(deps));
  app.route("/", hotelesQuotesRoutes(deps));
  app.route("/", hotelesReservasRoutes(deps));
  return app;
}
