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
import { hotelesCfdiRoutes } from "./cfdi.ts";
import { hotelesFraudeRoutes } from "./fraude.ts";
import { hotelesNightAuditRoutes } from "./night-audit.ts";
import { hotelesHousekeepingRoutes } from "./housekeeping.ts";
import { hotelesAdminDiscoveryRoutes } from "./admin-discovery.ts";
import { hotelesAsistenciaRoutes } from "./asistencia.ts";
import { hotelesPlRoutes } from "./pl.ts";
import { hotelesEmailDispatchRoutes } from "./email-dispatch.ts";
import { hotelesAdminCatalogoRoutes } from "./admin-catalogo.ts";

export function hotelesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", hotelesFoliosRoutes(deps));
  app.route("/", hotelesPedidosFnbRoutes(deps));
  app.route("/", hotelesQuotesRoutes(deps));
  app.route("/", hotelesReservasRoutes(deps));
  // Fase 5 — H5/REQ-BO-001/002 (CFDI de hospedaje) + H16-014/REQ-REC-014 (fraude interno).
  app.route("/", hotelesCfdiRoutes(deps));
  app.route("/", hotelesFraudeRoutes(deps));
  // Fase 6 — H5/REQ-REV-013 (night audit propio) + REQ-HK-008/011 (housekeeping: turnos LFT + tickets de mantenimiento).
  app.route("/", hotelesNightAuditRoutes(deps));
  app.route("/", hotelesHousekeepingRoutes(deps));
  // Fase 7 — descubrimiento de organización/property para el panel web de staff.
  app.route("/", hotelesAdminDiscoveryRoutes(deps));
  // Fase 8 — REQ-BO-024 (LFT art.132 fr.XXXIV): checador de asistencia inalterable.
  app.route("/", hotelesAsistenciaRoutes(deps));
  // Fase 10 — REQ-BO-010 (P0): back-office financiero, P&L USALI + punto de equilibrio dinámico.
  app.route("/", hotelesPlRoutes(deps));
  // Fase 12 — hallazgo ALTA: correo transaccional real al huésped (dispatcher de
  // `channel='email'` de `hoteles.messaging_outbox`, ver email-dispatch.ts).
  app.route("/", hotelesEmailDispatchRoutes(deps));
  // Fix hallazgo CRÍTICO — alta REAL de catálogo (tipos de habitación/habitaciones
  // físicas/tarifas), ver admin-catalogo.ts.
  app.route("/", hotelesAdminCatalogoRoutes(deps));
  return app;
}
