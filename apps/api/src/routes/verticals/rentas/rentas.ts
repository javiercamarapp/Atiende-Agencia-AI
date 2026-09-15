// Agregador de las rutas Hono del vertical rentas — 3 de Fase 1 + 3 de Fase 2 (pricing
// CRUD, owner statement, payout/conciliación) — mismo patrón de montaje que
// hotelesRoutes/restaurantesPublicRoutes en apps/api/src/app.ts.
import { Hono } from "hono";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import type { AppDeps } from "../../../deps.ts";
import { rentasReservasRoutes } from "./reservas.ts";
import { rentasBloqueosRoutes } from "./bloqueos.ts";
import { rentasCotizacionesRoutes } from "./cotizaciones.ts";
import { rentasFinanzasRoutes } from "./finanzas.ts";
import { rentasPricingConfigRoutes } from "./pricing-config.ts";
import { rentasFinanzasStatementsRoutes } from "./finanzas-statements.ts";
import { rentasFinanzasPayoutsRoutes } from "./finanzas-payouts.ts";
import { rentasOwnerPortalInviteRoutes } from "./owner-portal-invite.ts";
import { rentasOwnerPortalRoutes } from "./owner-portal.ts";
import { rentasIcalSyncRoutes } from "./ical-sync.ts";
import { rentasIcalFeedPublicoRoutes } from "./ical-feed-publico.ts";
import { rentasIcalSyncCronRoutes } from "./ical-sync-cron.ts";
import { rentasMensajeriaConversacionesRoutes } from "./mensajeria-conversaciones.ts";
import { rentasMensajeriaBorradoresRoutes } from "./mensajeria-borradores.ts";
import { rentasMensajeriaPlantillasRoutes } from "./mensajeria-plantillas.ts";
import { rentasMensajeriaPoliticasRoutes } from "./mensajeria-politicas.ts";
import { rentasEmailDispatchRoutes } from "./email-dispatch.ts";
import { rentasCheckInRecordatorioRoutes } from "./checkin-recordatorio.ts";
import { rentasOnboardingRoutes } from "./onboarding.ts";
import { rentasAdminDiscoveryRoutes } from "./admin-discovery.ts";
import { rentasCalendarioRoutes } from "./calendario.ts";
import { rentasLimpiezaRoutes } from "./limpieza.ts";
import { rentasCheckoutSweepCronRoutes } from "./checkout-sweep-cron.ts";

export function rentasRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // Fase 3 -- portal de propietario: montado PRIMERO, a propósito. `:propertyId` es un
  // parámetro de ruta (wildcard) en TODAS las rutas de staff de abajo -- Hono empareja
  // por FORMA, no por semántica, así que el literal "owner-portal" en, por ejemplo,
  // `/rentas/owner-portal/statements/:id` también calza estructuralmente contra
  // `/rentas/:propertyId/statements/:id` (finanzas-statements.ts) con
  // propertyId="owner-portal". Si esa ruta de staff se registrara primero, su
  // `authMiddleware` (secreto de STAFF) correría antes que el middleware del portal y
  // rechazaría con 401 un token de propietario válido -- exactamente el bug que un test
  // de integración real de esta fase detectó. Montar owner-portal PRIMERO hace que su
  // handler exacto (ruta literal, sin wildcard) resuelva la request y nunca caiga al
  // patrón de staff. Esto NO abre ningún hueco para property ids reales (siempre UUID,
  // nunca literalmente "owner-portal"): el staff sigue funcionando exactamente igual
  // para cualquier propertyId real. Ver diseño Fase 3 §4 y el test "un token de
  // PROPIETARIO nunca abre una sesión de staff" / "GET /statements/:id" en
  // apps/api/tests/rentas-owner-portal.spec.ts.
  app.route("/", rentasOwnerPortalRoutes(deps));
  app.route("/", rentasOwnerPortalInviteRoutes(deps));

  // Fase 5 -- exportación pública del feed iCal (sin auth de staff, ver
  // ical-feed-publico.ts) montada junto al portal de propietario por la misma razón
  // documentada arriba: es una ruta literal (`.../feed.ics`) sin
  // requirePropertyMembership, así que montarla temprano evita cualquier ambigüedad
  // de forma con el patrón wildcard de las rutas de staff de abajo.
  app.route("/", rentasIcalFeedPublicoRoutes(deps));

  // Fase 11 -- onboarding self-serve del tenant (POST /rentas/onboarding/registro,
  // sin sesión, ver onboarding.ts) -- ruta literal, mismo criterio de orden que las
  // dos de arriba: montarla antes de las rutas de staff evita cualquier ambigüedad
  // de forma con el patrón wildcard `:propertyId` de abajo.
  app.route("/", rentasOnboardingRoutes(deps));

  app.route("/", rentasReservasRoutes(deps));
  app.route("/", rentasBloqueosRoutes(deps));
  app.route("/", rentasCotizacionesRoutes(deps));
  app.route("/", rentasFinanzasRoutes(deps));
  app.route("/", rentasPricingConfigRoutes(deps));
  app.route("/", rentasFinanzasStatementsRoutes(deps));
  app.route("/", rentasFinanzasPayoutsRoutes(deps));
  app.route("/", rentasIcalSyncRoutes(deps));
  // Cron interno (Fase 5) -- mismo patrón que citas/google-calendar-sync.ts: sin
  // requirePropertyMembership, guardado por x-atiende-internal-secret.
  app.route("/", rentasIcalSyncCronRoutes(deps));

  // Fase 7 -- mensajería con huésped: borrador de IA + aprobación humana obligatoria
  // ("un agente redacta la respuesta al huésped -- y esa respuesta no sale hasta que
  // alguien la aprueba"). Ver packages/domain-rentas/src/mensajeria/*, src/agentes/*.
  app.route("/", rentasMensajeriaConversacionesRoutes(deps));
  app.route("/", rentasMensajeriaBorradoresRoutes(deps));
  app.route("/", rentasMensajeriaPlantillasRoutes(deps));
  app.route("/", rentasMensajeriaPoliticasRoutes(deps));

  // Fase 9 -- correo transaccional real al huésped (confirmación al crear +
  // recordatorio de check-in 24-48h antes). Cron interno guardado por
  // x-atiende-internal-secret, mismo patrón que rentasIcalSyncCronRoutes arriba.
  app.route("/", rentasEmailDispatchRoutes(deps));
  app.route("/", rentasCheckInRecordatorioRoutes(deps));

  // Fase 12 — descubrimiento de organización/property para el panel web de staff.
  app.route("/", rentasAdminDiscoveryRoutes(deps));
  // Fase 13 — calendario visual del panel de staff: listado de unidades + listado
  // unificado de ocupaciones (reserva + bloqueo) por unidad.
  app.route("/", rentasCalendarioRoutes(deps));
  // Fase 17 — panel operativo del rol `limpieza`: listar tareas asignadas, marcar
  // checklist, completar tarea (con consumo de inventario), reportar/listar
  // incidencias de mantenimiento. Motor transaccional ya existía desde Fase 8 sin
  // ningún HTTP route montado (ver limpieza.ts).
  app.route("/", rentasLimpiezaRoutes(deps));
  // Cron interno -- dispara procesarCheckoutsPendientes (sweep de checkouts sin
  // tarea de limpieza vinculada), mismo patrón que rentasIcalSyncCronRoutes arriba:
  // sin requirePropertyMembership, guardado por x-atiende-internal-secret.
  app.route("/", rentasCheckoutSweepCronRoutes(deps));
  return app;
}
