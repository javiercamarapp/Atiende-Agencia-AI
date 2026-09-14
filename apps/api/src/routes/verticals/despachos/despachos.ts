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
import { despachosConciliacionRoutes } from "./conciliacion.ts";
import { despachosMigracionCatalogoRoutes } from "./migracion-catalogo.ts";
import { despachosDevolucionIvaRoutes } from "./devolucion-iva.ts";
import { despachosBookkeepingRoutes } from "./bookkeeping.ts";
import { despachosCierreMensualRoutes } from "./cierre-mensual.ts";

export function despachosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", despachosCfdiRoutes(deps));
  app.route("/", despachosRevisionesRoutes(deps));
  app.route("/", despachosVencimientosRoutes(deps));
  app.route("/", despachosDeclaracionesRoutes(deps));
  app.route("/", despachosNominaRoutes(deps));
  app.route("/", despachosConciliacionRoutes(deps));
  app.route("/", despachosMigracionCatalogoRoutes(deps));
  // Fase 6: papel de trabajo de devolución de IVA, bookkeeping/auto-clasificador de
  // pólizas, y cierre mensual (checklist + validaciones de balance + bloqueo de
  // edición de movimientos ya cerrados, este último enganchado en cfdi.ts).
  app.route("/", despachosDevolucionIvaRoutes(deps));
  app.route("/", despachosBookkeepingRoutes(deps));
  app.route("/", despachosCierreMensualRoutes(deps));
  return app;
}
