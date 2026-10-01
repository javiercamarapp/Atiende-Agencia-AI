// C-06 -- GET /v1/citas/properties/:propertyId/onboarding: checklist de "primeros pasos" del negocio, con el estado de
// cada paso DERIVADO en el servidor de datos reales (ver packages/domain-citas/src/onboarding.ts). Solo lectura, sin
// migracion: corre en la sesion del staff autenticado (RLS de siempre) y nunca confia en nada que envie el cliente.
//
// Autorizacion: owner/admin unicamente (`STAFF_INVITE_ROLES`), mismo umbral que los mensajes de WhatsApp y la bitacora;
// un `staff` recibe 403. Multi-sucursal: el calculo se acota a la sucursal de la ruta (`requirePropertyMembership`).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { STAFF_INVITE_ROLES, computeOnboardingChecklist } from "@atiende/domain-citas";
import type { AppDeps } from "../../../deps.ts";

export function citasOnboardingRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const path = "/v1/citas/properties/:propertyId/onboarding";
  app.use(path, authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get(path, async (c) => {
    assertVerticalRole(c, STAFF_INVITE_ROLES);
    const checklist = await computeOnboardingChecklist(deps.citasRepo(c.get("db")), c.get("organizationId"), c.req.param("propertyId"));
    return c.json(checklist);
  });

  return app;
}
