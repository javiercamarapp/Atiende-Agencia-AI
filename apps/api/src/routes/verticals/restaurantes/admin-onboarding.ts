// R-33 -- GET /v1/restaurantes/:propertyId/admin/onboarding: checklist de onboarding de la organizacion, calculado con datos
// reales (sucursales, menu, horarios, coordenadas, cobertura, numeros de WhatsApp, agente, pedidos). Solo lectura (el aviso de "listo" lo emite la escritura que cierra el checklist: ver onboarding-aviso.ts). owner/admin
// (`STAFF_INVITE_ROLES`, como la configuracion); un staff acotado a una sucursal no ve el estado de toda la organizacion.
//
// Base sin migrar: el repositorio degrada con SAVEPOINT cada lectura a "sin configurar", asi que ningun punto se da por hecho
// por falta de tabla y nunca hay 500 por una migracion pendiente.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { STAFF_INVITE_ROLES, cargarOnboarding } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

export function restaurantesAdminOnboardingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/onboarding";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    // El checklist es de TODA la organizacion: una membership acotada a algunas sucursales no lo ve.
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null) throw Errors.forbidden("El checklist de onboarding es de toda la organización: requiere acceso a todas las sucursales.");
    c.header("Cache-Control", "no-store");
    const checklist = await cargarOnboarding(deps.restaurantesRepo(c.get("db")), organizationId);
    return c.json(checklist);
  });

  return app;
}
