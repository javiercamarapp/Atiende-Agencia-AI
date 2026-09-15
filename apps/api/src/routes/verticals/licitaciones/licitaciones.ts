// Agregador de las 3 rutas Hono elegidas para Fase 1 del vertical
// licitaciones — mismo patrón de montaje que hotelesRoutes/restaurantesPublicRoutes
// en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { licitacionesChecklistRoutes } from "./checklist.ts";
import { licitacionesProposalRoutes } from "./proposalEconomic.ts";
import { licitacionesCierreRoutes } from "./cierre.ts";
import { licitacionesTechnicalProposalRoutes } from "./technicalProposal.ts";
import { licitacionesTendersRoutes } from "./tenders.ts";
import { licitacionesMatchingProfileRoutes } from "./matchingProfile.ts";
import { licitacionesMatchingRoutes } from "./matching.ts";
import { licitacionesGoNoGoRoutes } from "./goNoGo.ts";
import { licitacionesSourcesRoutes } from "./sources.ts";
import { licitacionesDiscoverRoutes } from "./discover.ts";
import { licitacionesTenderVersionsRoutes } from "./tenderVersions.ts";
import { licitacionesContractRoutes } from "./contracts.ts";
import { licitacionesContractDocumentsRoutes } from "./contractDocuments.ts";
import { licitacionesContractBillingRoutes } from "./contractBilling.ts";
import { licitacionesInconformidadRoutes } from "./inconformidad.ts";
import { licitacionesFalloAutopsyRoutes } from "./falloAutopsy.ts";
import { licitacionesRenewalRadarRoutes } from "./renewalRadar.ts";
import { licitacionesAdminRoutes } from "./admin.ts";
import { licitacionesAdminStaffRoutes } from "./admin-staff.ts";
import { licitacionesAlertNotificationsRoutes } from "./alertNotifications.ts";
import { licitacionesResolutionRoutes } from "./resolution.ts";
import { licitacionesCompanyDataRoutes } from "./companyData.ts";

export function licitacionesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  app.route("/", licitacionesChecklistRoutes(deps));
  app.route("/", licitacionesProposalRoutes(deps));
  app.route("/", licitacionesCierreRoutes(deps));
  app.route("/", licitacionesTechnicalProposalRoutes(deps));
  // Fase 3 — matching/scoring y go/no-go (ver diseño Fase 3 §8).
  app.route("/", licitacionesTendersRoutes(deps));
  app.route("/", licitacionesMatchingProfileRoutes(deps));
  app.route("/", licitacionesMatchingRoutes(deps));
  app.route("/", licitacionesGoNoGoRoutes(deps));
  // Fase 5 — andamiaje de ingesta (REQ-004/005/146..150) e historial de
  // versiones de convocatoria + diff + cascada de invalidación (REQ-017/041/151..155).
  app.route("/", licitacionesSourcesRoutes(deps));
  app.route("/", licitacionesTenderVersionsRoutes(deps));
  // Fase 8 — ingesta automática real (compras_mx_historico) + recordatorios de plazo.
  app.route("/", licitacionesDiscoverRoutes(deps));
  // Fase 6 — seguimiento post-adjudicación (REQ-051..055): máquina de
  // estados del contrato + cobranza, extracción determinista del contrato
  // firmado, redactor de inconformidades, autopsia del fallo y radar de
  // renovaciones.
  app.route("/", licitacionesContractRoutes(deps));
  app.route("/", licitacionesContractDocumentsRoutes(deps));
  app.route("/", licitacionesContractBillingRoutes(deps));
  app.route("/", licitacionesInconformidadRoutes(deps));
  app.route("/", licitacionesFalloAutopsyRoutes(deps));
  app.route("/", licitacionesRenewalRadarRoutes(deps));
  // Fase 7 — resolución de propertyId para el panel web de backoffice (§ README
  // de este directorio: la Fase 1 solo construyó el login, sin este endpoint el
  // panel no tenía ningún camino real para entrar a ninguna pantalla).
  app.route("/", licitacionesAdminRoutes(deps));
  // Hallazgo de auditoría (severidad ALTA, "alta de organización/staff imposible
  // sin SQL") — CRUD real de invitaciones de staff, mismo patrón que
  // restaurantesAdminStaffRoutes (ver el comentario de cabecera de admin-staff.ts).
  app.route("/", licitacionesAdminStaffRoutes(deps));
  // Fase 10 — despacho proactivo real (correo) de recordatorios de plazo +
  // alertas de renovación + facturas vencidas de cobranza.
  app.route("/", licitacionesAlertNotificationsRoutes(deps));
  // Fase 16 — resolución won/lost (post-adjudicación antes inalcanzable) +
  // escritura de "datos de empresa" (propuestas que antes no podían salir de
  // PENDIENTE por no tener dónde capturar el dato real).
  app.route("/", licitacionesResolutionRoutes(deps));
  app.route("/", licitacionesCompanyDataRoutes(deps));
  return app;
}
