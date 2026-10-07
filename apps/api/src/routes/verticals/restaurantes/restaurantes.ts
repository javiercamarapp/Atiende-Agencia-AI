// Agregador de las rutas de staff autenticado del vertical restaurantes — mismo
// patrón de montaje que hoteles/hoteles.ts. Separado de public.ts/voice-tools.ts/
// whatsapp.ts (Fase 1-2, sin `authMiddleware`) porque Fase 3 introduce las PRIMERAS
// rutas de staff autenticado de este vertical (ver diseño Fase 3 §0/§2).
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { restaurantesAdminKpisRoutes } from "./admin-kpis.ts";
import { restaurantesAdminDataChatRoutes } from "./admin-data-chat.ts";
import { restaurantesAdminCatalogRoutes } from "./admin-catalog.ts";
import { restaurantesAdminPromotionsRoutes } from "./admin-promotions.ts";
import { restaurantesAdminBranchesRoutes } from "./admin-branches.ts";
import { restaurantesAdminOrdersRoutes } from "./admin-orders.ts";
import { restaurantesAdminCustomersRoutes } from "./admin-customers.ts";
import { restaurantesAdminStaffRoutes } from "./admin-staff.ts";
import { restaurantesAdminAvisosRoutes } from "./admin-avisos.ts";
import { restaurantesRepartidorOrdersRoutes } from "./repartidor-orders.ts";
import { restaurantesEmailDispatchRoutes } from "./email-dispatch.ts";
import { restaurantesProgramadosInternoRoutes } from "./programados-interno.ts";
import { restaurantesVozHuerfanasRoutes } from "./voz-huerfanas.ts";
import { restaurantesCierresRoutes } from "./cierres.ts";
import { restaurantesAutopilotoRoutes } from "./autopiloto.ts";
import { restaurantesCierresInternoRoutes } from "./cierres-interno.ts";
import { restaurantesRepartidorPerfilRoutes } from "./repartidor-perfil.ts";
import { restaurantesRepartidorHistorialRoutes } from "./repartidor-historial.ts";
import { restaurantesExportacionesRoutes } from "./exportaciones.ts";
import { restaurantesRepartidorLicenciasInternoRoutes } from "./repartidor-licencias-interno.ts";
import { restaurantesAuditoriaRoutes } from "./auditoria.ts";
import { restaurantesAdminConfigRoutes } from "./admin-config.ts";
import { restaurantesAdminSitioPublicoRoutes } from "./admin-sitio-publico.ts";
import { restaurantesAdminModeloPmRoutes } from "./admin-modelo-pm.ts";
import { restaurantesAdminConocimientoRoutes } from "./admin-conocimiento.ts";
import { restaurantesAdminOnboardingRoutes } from "./admin-onboarding.ts";
import { restaurantesAjustesAgenteRoutes, restaurantesAjustesLlamadaInternoRoutes } from "./ajustes-agente.ts";
import { restaurantesVozAdminRoutes } from "./voz-admin.ts";
import { restaurantesAgentePreviewRoutes } from "./agente-preview.ts";
import { restaurantesVozInternoRoutes } from "./voz-interno.ts";
import { restaurantesVozLlamadaRoutes } from "./voz-llamada.ts";
import { restaurantesVozKpiRoutes } from "./voz-kpi.ts";
import { restaurantesAdminMarketingRoutes } from "./admin-marketing.ts";
import { restaurantesAdminAlertasDuenioRoutes } from "./admin-alertas-duenio.ts";
import { restaurantesWhatsappKpiRoutes } from "./whatsapp-kpi.ts";
import { restaurantesConversacionesAdminRoutes } from "./conversaciones-admin.ts";
import { restaurantesAdminVoiceSecretRoutes } from "./admin-voice-secret.ts";
import { restaurantesPrivacidadRoutes } from "./privacidad.ts";
import { restaurantesPrivacidadInternoRoutes } from "./privacidad-interno.ts";
import { restaurantesAdminSoftRestauranteRoutes } from "./admin-softrestaurant.ts";
import { restaurantesSoftRestauranteDispatchRoutes } from "./softrestaurant-dispatch.ts";

export function restaurantesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", restaurantesAdminKpisRoutes(deps));
  // "Chatea con tus datos" (motor compartido @atiende/agent-core/data-chat + catalogo cerrado de restaurantes).
  app.route("/", restaurantesAdminDataChatRoutes(deps));
  // Fase 5 — back-office CORE (catálogo/sucursales/pedidos/clientes, ver diseño §1).
  app.route("/", restaurantesAdminCatalogRoutes(deps));
  // Fase 11 — promociones/marketing: CRUD admin real de código de descuento (ver
  // domain-restaurantes/src/promotions.ts).
  app.route("/", restaurantesAdminPromotionsRoutes(deps));
  app.route("/", restaurantesAdminBranchesRoutes(deps));
  app.route("/", restaurantesAdminOrdersRoutes(deps));
  app.route("/", restaurantesAdminCustomersRoutes(deps));
  // Fase 8 — superficie real del rol "repartidor" (ver domain-restaurantes/src/
  // roles.ts::REPARTIDOR_ROLES), acotada a SU propio pedido — nunca gestión.
  app.route("/", restaurantesRepartidorOrdersRoutes(deps));
  // Fase 10 — alta/gestión de cuentas de staff (invitar/listar/revocar), ver el
  // comentario de cabecera de admin-staff.ts para la decisión de diseño completa.
  app.route("/", restaurantesAdminStaffRoutes(deps));
  // R-16 (migración 043): preferencias de avisos por persona y umbral de entrega tardía (ver admin-avisos.ts).
  app.route("/", restaurantesAdminAvisosRoutes(deps));
  // Hallazgo de auditoría — dispatcher real del canal de correo (channel='email'
  // del outbox), mismo patrón exacto que citasEmailDispatchRoutes.
  app.route("/", restaurantesEmailDispatchRoutes(deps));
  // R-11 (migración 034): promoción de pedidos programados por endpoint interno (sin cron, ver el archivo).
  app.route("/", restaurantesProgramadosInternoRoutes(deps));
  // QA R1 (migración 042): barrido cron de llamadas de voz sin cierre.
  app.route("/", restaurantesVozHuerfanasRoutes(deps));
  app.route("/", restaurantesCierresInternoRoutes(deps));
  app.route("/", restaurantesCierresRoutes(deps));
  app.route("/", restaurantesAutopilotoRoutes(deps));
  // R-15 (migración 044): perfil operativo del repartidor + barrido interno de licencias por vencer.
  app.route("/", restaurantesRepartidorPerfilRoutes(deps));
  app.route("/", restaurantesRepartidorHistorialRoutes(deps));
  // R-17: exportar Historial y Clientes a CSV/PDF (owner/admin).
  app.route("/", restaurantesExportacionesRoutes(deps));
  app.route("/", restaurantesRepartidorLicenciasInternoRoutes(deps));
  // FASE 3 (producto) — bitácora de auditoría del staff (ver
  // packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql).
  app.route("/", restaurantesAuditoriaRoutes(deps));
  // FASE 3 (producto) — configuración editable del panel (WhatsApp/zonas
  // conocidas), owner/admin -- ver el comentario de cabecera de admin-config.ts.
  app.route("/", restaurantesAdminConfigRoutes(deps));
  // R-38 (migración 062): marca del storefront público ("Sitio público"), owner/admin.
  app.route("/", restaurantesAdminSitioPublicoRoutes(deps));
  // Modelo PM (migración 023) — política/cobertura/WhatsApp por sucursal y marcas no_domicilio.
  app.route("/", restaurantesAdminModeloPmRoutes(deps));
  app.route("/", restaurantesAdminConocimientoRoutes(deps));
  // R-33: checklist de onboarding calculado con datos reales (solo lectura, owner/admin).
  app.route("/", restaurantesAdminOnboardingRoutes(deps));
  // Voz propia (migración 025): config por sucursal, preview, conversaciones (panel) y registrador
  // de sistema del servicio de voz — ver el comentario de cabecera de voz-admin.ts/voz-interno.ts.
  app.route("/", restaurantesVozAdminRoutes(deps));
  // «Probar agente» del panel: chat de prueba SIN efectos (modo preview del registro de tools), sin persistir la conversacion.
  app.route("/", restaurantesAgentePreviewRoutes(deps));
  app.route("/", restaurantesVozInternoRoutes(deps));
  // Ajustes del agente por organizacion (migración 055: modelo, temperatura, voz, fondo) + conocimiento automatico + lado sistema del servicio de llamadas.
  app.route("/", restaurantesAjustesAgenteRoutes(deps));
  app.route("/", restaurantesAjustesLlamadaInternoRoutes(deps));
  // Worker de telefonía (migración 067): contexto de la llamada, costo por escalón, modo de entrada y KPI de desborde/latencia.
  app.route("/", restaurantesVozLlamadaRoutes(deps));
  // R-13 (migración 035): KPI de voz, costo por día y alertas operativas internas (panel + bitácora).
  app.route("/", restaurantesVozKpiRoutes(deps));
  app.route("/", restaurantesWhatsappKpiRoutes(deps));
  // Autopiloto 2 (migración 052): campañas de reactivación de clientes inactivos con aprobación de un clic (owner/admin).
  app.route("/", restaurantesAdminMarketingRoutes(deps));
  // Autopiloto 2: umbrales configurables de las alertas al dueño («WhatsApp silencioso»), owner/admin.
  app.route("/", restaurantesAdminAlertasDuenioRoutes(deps));
  // PM PR-9 -- privacidad: solicitudes ARCO + configuración (panel, owner/admin) y lado sistema
  // (purga por retención, apertura/consentimiento/ARCO de voz). Migración 030.
  app.route("/", restaurantesPrivacidadRoutes(deps));
  app.route("/", restaurantesPrivacidadInternoRoutes(deps));
  // R-21 (migración 028): bandeja de conversaciones por sucursal, handoff a humano, turnos de personal y callbacks.
  app.route("/", restaurantesConversacionesAdminRoutes(deps));
  // Secreto de voz por sucursal (hash + rotación con ventana de gracia, migración 026).
  app.route("/", restaurantesAdminVoiceSecretRoutes(deps));
  // SoftRestaurant (POS de PM) -- bandera por organizacion, comandas pendientes/fallidas y
  // captura manual (staff) + dispatcher del outbox (cron). Ver softrestaurant/README.md.
  app.route("/", restaurantesAdminSoftRestauranteRoutes(deps));
  app.route("/", restaurantesSoftRestauranteDispatchRoutes(deps));
  return app;
}
