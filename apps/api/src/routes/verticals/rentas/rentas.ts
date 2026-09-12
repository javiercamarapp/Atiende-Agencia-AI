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

  app.route("/", rentasReservasRoutes(deps));
  app.route("/", rentasBloqueosRoutes(deps));
  app.route("/", rentasCotizacionesRoutes(deps));
  app.route("/", rentasFinanzasRoutes(deps));
  app.route("/", rentasPricingConfigRoutes(deps));
  app.route("/", rentasFinanzasStatementsRoutes(deps));
  app.route("/", rentasFinanzasPayoutsRoutes(deps));
  return app;
}
