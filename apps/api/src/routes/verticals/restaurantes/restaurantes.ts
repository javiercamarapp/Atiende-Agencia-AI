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
import { restaurantesRepartidorOrdersRoutes } from "./repartidor-orders.ts";
import { restaurantesEmailDispatchRoutes } from "./email-dispatch.ts";
import { restaurantesProgramadosInternoRoutes } from "./programados-interno.ts";
import { restaurantesAuditoriaRoutes } from "./auditoria.ts";
import { restaurantesAdminConfigRoutes } from "./admin-config.ts";
import { restaurantesAdminModeloPmRoutes } from "./admin-modelo-pm.ts";
import { restaurantesVozAdminRoutes } from "./voz-admin.ts";
import { restaurantesVozInternoRoutes } from "./voz-interno.ts";
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
  // Hallazgo de auditoría — dispatcher real del canal de correo (channel='email'
  // del outbox), mismo patrón exacto que citasEmailDispatchRoutes.
  app.route("/", restaurantesEmailDispatchRoutes(deps));
  // R-11 (migración 034): promoción de pedidos programados por endpoint interno (sin cron, ver el archivo).
  app.route("/", restaurantesProgramadosInternoRoutes(deps));
  // FASE 3 (producto) — bitácora de auditoría del staff (ver
  // packages/domain-restaurantes/migrations/019_restaurantes_audit_log.sql).
  app.route("/", restaurantesAuditoriaRoutes(deps));
  // FASE 3 (producto) — configuración editable del panel (WhatsApp/zonas
  // conocidas), owner/admin -- ver el comentario de cabecera de admin-config.ts.
  app.route("/", restaurantesAdminConfigRoutes(deps));
  // Modelo PM (migración 023) — política/cobertura/WhatsApp por sucursal y marcas no_domicilio.
  app.route("/", restaurantesAdminModeloPmRoutes(deps));
  // Voz propia (migración 025): config por sucursal, preview, conversaciones (panel) y registrador
  // de sistema del servicio de voz — ver el comentario de cabecera de voz-admin.ts/voz-interno.ts.
  app.route("/", restaurantesVozAdminRoutes(deps));
  app.route("/", restaurantesVozInternoRoutes(deps));
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
