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
import { hotelesReservasFechasRoutes } from "./reservas-fechas.ts";
import { hotelesListaEsperaRoutes } from "./lista-espera.ts";
import { hotelesCfdiRoutes } from "./cfdi.ts";
import { hotelesFraudeRoutes } from "./fraude.ts";
import { hotelesNightAuditRoutes } from "./night-audit.ts";
import { hotelesHousekeepingRoutes } from "./housekeeping.ts";
import { hotelesRecepcionRoutes } from "./recepcion.ts";
import { hotelesHuespedesRoutes } from "./huespedes.ts";
import { hotelesAdminDiscoveryRoutes } from "./admin-discovery.ts";
import { hotelesAsistenciaRoutes } from "./asistencia.ts";
import { hotelesPlRoutes } from "./pl.ts";
import { hotelesEmailDispatchRoutes } from "./email-dispatch.ts";
import { hotelesAdminCatalogoRoutes } from "./admin-catalogo.ts";
import { hotelesPropertyConfigRoutes } from "./property-config.ts";
import { hotelesConfiguracionRoutes } from "./configuracion.ts";
import { hotelesPrimerosPasosRoutes } from "./primeros-pasos.ts";
import { hotelesMensajeriaConfigRoutes } from "./mensajeria-config.ts";
import { hotelesAdminStaffRoutes } from "./admin-staff.ts";
import { hotelesRevenueRoutes } from "./revenue.ts";
import { hotelesRevenueRecomendacionesRoutes } from "./revenue-recomendaciones.ts";
import { hotelesRevenueRecommendationsCronRoutes } from "./revenue-recommendations-cron.ts";
import { hotelesReputacionRoutes } from "./reputacion.ts";
import { hotelesIdentidadRoutes } from "./identidad.ts";
import { hotelesIdentidadPurgaCronRoutes } from "./identidad-purga-cron.ts";
import { hotelesPrivacidadRoutes } from "./privacidad.ts";
import { hotelesPrivacidadPublicaRoutes } from "./privacidad-publica.ts";
import { hotelesTicketsRoutes } from "./tickets.ts";
import { hotelesTicketsSlaCronRoutes } from "./tickets-sla-cron.ts";
import { hotelesHoldsVencidosCronRoutes } from "./holds-vencidos-cron.ts";
import { hotelesHousekeepingDiaCronRoutes } from "./housekeeping-dia-cron.ts";
import { hotelesAdminDataChatRoutes } from "./admin-data-chat.ts";
import { hotelesAgentesRoutes } from "./agentes.ts";
import { hotelesAgentesExpiracionCronRoutes } from "./agentes-expiracion-cron.ts";
import { hotelesGruposRoutes } from "./grupos.ts";
import { hotelesGruposLiberacionCronRoutes } from "./grupos-liberacion-cron.ts";
import { hotelesReservasAgenteRoutes } from "./reservas-agente.ts";
import { hotelesConversacionesRoutes } from "./conversaciones.ts";

export function hotelesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", hotelesFoliosRoutes(deps));
  // "Chatea con tus datos" (motor compartido @atiende/agent-core/data-chat + catalogo cerrado de hoteles), solo owner/gm.
  app.route("/", hotelesAdminDataChatRoutes(deps));
  app.route("/", hotelesPedidosFnbRoutes(deps));
  app.route("/", hotelesQuotesRoutes(deps));
  app.route("/", hotelesReservasRoutes(deps));
  // H-28 -- cambio de fechas con recotizacion (previsualizar + confirmar). Cuelga de /reservas/*: hereda el middleware de reservas.ts, por eso va DESPUES.
  app.route("/", hotelesReservasFechasRoutes(deps));
  // H-12 -- lista de espera (cola FIFO, oferta automatica al liberar noches y aceptar crea la reserva).
  app.route("/", hotelesListaEsperaRoutes(deps));
  // Fase 5 — H5/REQ-BO-001/002 (CFDI de hospedaje) + H16-014/REQ-REC-014 (fraude interno).
  app.route("/", hotelesCfdiRoutes(deps));
  app.route("/", hotelesFraudeRoutes(deps));
  // Fase 6 — H5/REQ-REV-013 (night audit propio) + REQ-HK-008/011 (housekeeping: turnos LFT + tickets de mantenimiento).
  app.route("/", hotelesNightAuditRoutes(deps));
  app.route("/", hotelesHousekeepingRoutes(deps));
  // H-28 -- recepcion / front desk: llegadas, salidas, en casa, rack, check-in/out de un clic y cambio de habitacion.
  app.route("/", hotelesRecepcionRoutes(deps));
  // H-27 -- ficha de huesped (CRM): perfil, historial, notas, contactos, consentimiento y estado ARCO.
  app.route("/", hotelesHuespedesRoutes(deps));
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
  // FASE 3 (producto) — zona horaria por negocio: GET/PUT
  // /hoteles/:propertyId/configuracion (owner/gm), ver property-config.ts y
  // migrations/030_zona_horaria_property.sql.
  app.route("/", hotelesPropertyConfigRoutes(deps));
  // H-P3-04 (P1) -- impuestos, politica de cancelacion, sobreventa y listar/editar tarifas desde el panel (owner/gm; accountant lee), migracion 047.
  app.route("/", hotelesConfiguracionRoutes(deps));
  // H-P3-06 (P1) -- "Primeros pasos": checklist con datos reales + gate (owner/gm), ver primeros-pasos.ts.
  app.route("/", hotelesPrimerosPasosRoutes(deps));
  // H-29 -- canal WhatsApp y agente de voz editables desde el panel (owner/gm; el secreto de voz es write-only), ver mensajeria-config.ts.
  app.route("/", hotelesMensajeriaConfigRoutes(deps));
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
  app.route("/", hotelesRevenueRecommendationsCronRoutes(deps));
  // Fase 11/13 — REQ-CRM-002/003: reputación/CRM -- wiring HTTP real del
  // clasificador + índice agregado (dominio y modelo de datos ya existían desde
  // Fase 11; esta rama agrega el primer invocador real, ver reputacion.ts).
  app.route("/", hotelesReputacionRoutes(deps));
  // H-01 (P0) -- boveda de identidad cifrada + registro migratorio + purga con doble
  // control (migrations/031_hoteles_boveda_identidad.sql), ver identidad.ts y el cron de
  // purga por retencion (identidad-purga-cron.ts).
  app.route("/", hotelesIdentidadRoutes(deps));
  app.route("/", hotelesIdentidadPurgaCronRoutes(deps));
  // H-02 (P0) -- consentimiento, aviso de privacidad, ARCO, bloqueo previo a la purga, retencion legal e
  // incidentes (migrations/032_hoteles_consentimiento_arco_incidentes.sql), ver privacidad.ts.
  app.route("/", hotelesPrivacidadRoutes(deps));
  // H-30 (P1) -- superficie PUBLICA de privacidad del huesped (aviso, ARCO publico verificado, mis datos), sin login; migracion 042.
  app.route("/", hotelesPrivacidadPublicaRoutes(deps));
  // H-05 (P0) -- tickets de huesped con SLA, escalacion automatica, bitacora y creacion desde resenas
  // (migrations/034_guest_ticket_sla_escalacion.sql), ver tickets.ts y el barrido de SLA (tickets-sla-cron.ts).
  app.route("/", hotelesTicketsRoutes(deps));
  app.route("/", hotelesTicketsSlaCronRoutes(deps));
  // H-03 (P0) -- catalogo de agentes (kill switch, presupuesto, costo), guardrails, politicas, plantillas de WhatsApp
  // versionadas y cola de aprobaciones humanas (migrations/035_hoteles_agentes_aprobaciones.sql), ver agentes.ts y el
  // cron de expiracion (agentes-expiracion-cron.ts).
  app.route("/", hotelesAgentesRoutes(deps));
  app.route("/", hotelesAgentesExpiracionCronRoutes(deps));
  // H-06 (P1) -- grupos: cotizacion con vigencia, bloqueo de cuartos con fecha de liberacion, pickup, rooming y anticipos
  // registrados (migrations/036_hoteles_grupos.sql), ver grupos.ts y la liberacion por cutoff (grupos-liberacion-cron.ts,
  // sin cron programado).
  app.route("/", hotelesGruposRoutes(deps));
  app.route("/", hotelesGruposLiberacionCronRoutes(deps));
  // H-25 (P0) -- agente de reservas (WhatsApp y voz): lado staff (holds, aprobacion, link de pago registrado, politica), migracion 037.
  app.route("/", hotelesReservasAgenteRoutes(deps));
  // H-P3-03 (P1) -- barrido cada 15 min de las pre-reservas vencidas (booking_hold_expire_due, antes sin llamador), ver holds-vencidos-cron.ts.
  app.route("/", hotelesHoldsVencidosCronRoutes(deps));
  // H-P3-04 (P1) -- el dia de housekeeping arranca solo (genera tareas y asigna, horario por property), ver housekeeping-dia-cron.ts.
  app.route("/", hotelesHousekeepingDiaCronRoutes(deps));
  // H-20 (P1) -- bandeja de conversaciones de WhatsApp con handoff a humano (tomar / devolver / cerrar / notas / responder via outbox), migracion 043.
  app.route("/", hotelesConversacionesRoutes(deps));
  return app;
}
