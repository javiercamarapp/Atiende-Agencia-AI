// R-33 -- GET /v1/restaurantes/:propertyId/admin/onboarding (y /gate, la version corta para el shell): checklist de onboarding de la organizacion, calculado con datos
// reales (sucursales, menu, horarios, coordenadas, cobertura, numeros de WhatsApp, agente, pedidos). Solo lectura (el aviso de "listo" lo emite la escritura que cierra el checklist: ver onboarding-aviso.ts). owner/admin
// (`STAFF_INVITE_ROLES`, como la configuracion); un staff acotado a una sucursal no ve el estado de toda la organizacion.
//
// Base sin migrar: el repositorio degrada con SAVEPOINT cada lectura a "sin configurar", asi que ningun punto se da por hecho
// por falta de tabla y nunca hay 500 por una migracion pendiente.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { STAFF_INVITE_ROLES } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";
import { cargarOnboardingDeOrganizacion } from "./onboarding-carga.ts";

export function restaurantesAdminOnboardingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/restaurantes/:propertyId/admin/onboarding";
  const gatePath = `${path}/gate`;
  for (const p of [path, gatePath]) app.use(p, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function medir(c: Context<CoreAuthHonoEnv>) {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const organizationId = c.get("organizationId");
    // El checklist es de TODA la organizacion: una membership acotada a algunas sucursales no lo ve.
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    if (scope !== null) throw Errors.forbidden("El checklist de onboarding es de toda la organización: requiere acceso a todas las sucursales.");
    c.header("Cache-Control", "no-store");
    return cargarOnboardingDeOrganizacion(deps, c, organizationId);
  }

  app.get(path, async (c) => c.json(await medir(c)));

  // Gate consultable por otras piezas (shell, banner del Resumen): version corta del mismo calculo. Regla: bloquea solo si hay obligatorios
  // pendientes y la organizacion aun no tiene pedidos (una organizacion que ya opera nunca se desvia).
  app.get(gatePath, async (c) => {
    const checklist = await medir(c);
    return c.json({ ...checklist.gate, listoParaOperar: checklist.listoParaOperar });
  });

  return app;
}
