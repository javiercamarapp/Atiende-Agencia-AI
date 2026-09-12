// Agregador de las rutas Hono del vertical despachos — mismo patrón de montaje que
// hotelesRoutes/restaurantesPublicRoutes en apps/api/src/app.ts. Las 3 originales de
// Fase 1 (cfdi/revisiones/vencimientos) más declaraciones/nomina (Fase 4: cierre de
// gap, exponen los motores de Fase 2/3 que quedaron sin ruta HTTP).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { despachosCfdiRoutes } from "./cfdi.ts";
import { despachosRevisionesRoutes } from "./revisiones.ts";
import { despachosVencimientosRoutes } from "./vencimientos.ts";
import { despachosDeclaracionesRoutes } from "./declaraciones.ts";
import { despachosNominaRoutes } from "./nomina.ts";

export function despachosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", despachosCfdiRoutes(deps));
  app.route("/", despachosRevisionesRoutes(deps));
  app.route("/", despachosVencimientosRoutes(deps));
  app.route("/", despachosDeclaracionesRoutes(deps));
  app.route("/", despachosNominaRoutes(deps));
  return app;
}
