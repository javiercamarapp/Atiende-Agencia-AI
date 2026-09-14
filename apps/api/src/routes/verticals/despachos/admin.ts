// Fase 9 (paridad de UI del panel web) — despachosAdminRoutes:
// `GET /v1/despachos/:orgSlug/admin/branches`, resolución de propertyId(s) desde el
// slug de la organización. Mismo rol EXACTO que
// `GET /v1/licitaciones/:orgSlug/admin/branches` (licitaciones/admin.ts) y
// `GET /v1/citas/:orgSlug/admin/branches` (citas/admin.ts): el panel de backoffice
// solo conoce el slug de la organización tras el login (despachos/lib/auth-client.ts
// nunca trae un propertyId), pero todas las rutas de staff de despachos
// (cierre-mensual/cfdi/etc.) SÍ lo exigen vía `requirePropertyMembership("propertyId")`.
// Sin este endpoint, el panel web no tenía ningún camino real para resolver ese
// propertyId — era el primer eslabón faltante antes que cualquier pantalla nueva de
// esta fase (dashboard de cierre mensual / CFDI emitidos).
import { Hono } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function despachosAdminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/despachos/:orgSlug/admin/branches", authMiddleware(deps.env), dbSession(deps.engine));
  app.get("/v1/despachos/:orgSlug/admin/branches", async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const repo = deps.despachosRepo(c.get("db"));
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);

    // Mismo patrón exacto que GET /v1/licitaciones/:orgSlug/admin/branches: resuelve
    // la org por slug + verifica membership vía `coreRepo.findMembershipsByUserId` —
    // ninguna superficie de seguridad nueva.
    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === org.id);
    if (!membership) throw Errors.forbidden("No perteneces a esta organización.");

    const branches = await repo.listPropertiesForOrganization(org.id);
    const visible = membership.propertyIds === null ? branches : branches.filter((b) => membership.propertyIds!.includes(b.propertyId));
    return c.json({ branches: visible.map((b) => ({ propertyId: b.propertyId, name: b.name })) });
  });

  return app;
}
