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
import { despachosContabilidadElectronicaRoutes } from "./contabilidad-electronica.ts";
import { despachosCierreMensualRoutes } from "./cierre-mensual.ts";
import { despachosAdminRoutes } from "./admin.ts";
import { despachosNotificationsRoutes } from "./notifications.ts";
import { despachosCobranzaRoutes } from "./cobranza.ts";

export function despachosRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  // Fase 9 — resolución de propertyId(s) desde el slug de la organización, primer
  // eslabón que necesita CUALQUIER pantalla nueva del panel web (ver admin.ts).
  app.route("/", despachosAdminRoutes(deps));
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
  // Hallazgo de auditoría: contabilidad electrónica SAT (Anexo 24) tenía motor
  // completo (catálogo/balanza/paquete, ver contabilidad-electronica.ts) pero
  // cero rutas HTTP — la tarea "contabilidad_elect" del cierre mensual solo
  // comprobaba un booleano manual sin poder generar el paquete real.
  app.route("/", despachosContabilidadElectronicaRoutes(deps));
  app.route("/", despachosCierreMensualRoutes(deps));
  // Hallazgo de auditoría (severidad ALTA) — infraestructura de correo real
  // (outbox + dispatch + recordatorios de cobranza), ver notifications.ts.
  app.route("/", despachosNotificationsRoutes(deps));
  // Hallazgo de auditoría (severidad ALTA) — cobranza (Fase 10) tenía motor +
  // persistencia completos pero cero rutas HTTP y cero UI, ver cobranza.ts.
  app.route("/", despachosCobranzaRoutes(deps));
  return app;
}
