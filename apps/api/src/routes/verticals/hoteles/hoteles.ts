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
import { hotelesAdminStaffRoutes } from "./admin-staff.ts";
import { hotelesRevenueRoutes } from "./revenue.ts";
import { hotelesRevenueRecomendacionesRoutes } from "./revenue-recomendaciones.ts";
import { hotelesReputacionRoutes } from "./reputacion.ts";

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
  // Fix hallazgo auditoría (rubro 1, "completitud funcional" — alta de cliente de
  // principio a fin: organización + property + STAFF + primera venta): hoteles era
  // la única de las 6 verticales sin forma de invitar staff adicional, ver
  // admin-staff.ts.
  app.route("/", hotelesAdminStaffRoutes(deps));
  // Fase 9 — REQ-REV-003/004/005/007: motor de revenue management (pricing) --
  // wiring HTTP real del gate shadow/propone/autopilot + backtests walk-forward
  // (dominio y migración ya existían desde Fase 9; esta rama agrega el primer
  // invocador real, ver revenue.ts).
  app.route("/", hotelesRevenueRoutes(deps));
  // Fase 10 — motor de recomendaciones de tarifa v1: el motor que PRODUCE una
  // recomendación (pickup/evento/compset), sobre el gate/backtest de arriba --
  // ver revenue-recomendaciones.ts y migrations/029_rate_recommendation_engine.sql.
  app.route("/", hotelesRevenueRecomendacionesRoutes(deps));
  // Fase 11/13 — REQ-CRM-002/003: reputación/CRM -- wiring HTTP real del
  // clasificador + índice agregado (dominio y modelo de datos ya existían desde
  // Fase 11; esta rama agrega el primer invocador real, ver reputacion.ts).
  app.route("/", hotelesReputacionRoutes(deps));
  return app;
}
