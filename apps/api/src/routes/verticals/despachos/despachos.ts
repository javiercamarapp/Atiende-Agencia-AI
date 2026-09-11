// Agregador de las 3 rutas Hono elegidas para Fase 1 del vertical despachos — mismo
// patrón de montaje que hotelesRoutes/restaurantesPublicRoutes en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { despachosCfdiRoutes } from "./cfdi.ts";
import { despachosRevisionesRoutes } from "./revisiones.ts";
import { despachosVencimientosRoutes } from "./vencimientos.ts";

export function despachosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", despachosCfdiRoutes(deps));
  app.route("/", despachosRevisionesRoutes(deps));
  app.route("/", despachosVencimientosRoutes(deps));
  return app;
}
