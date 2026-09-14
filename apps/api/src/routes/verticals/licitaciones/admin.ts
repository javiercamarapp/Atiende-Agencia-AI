// Fase 7 pieza 1 — licitacionesAdminRoutes: `GET /v1/licitaciones/:orgSlug/admin/branches`,
// resolución de propertyId(s) desde el slug de la organización. Mismo rol exacto
// que `GET /v1/citas/:orgSlug/admin/branches` (admin.ts) y
// `GET /v1/restaurantes/:orgSlug/admin/branches` (admin-kpis.ts): el panel de
// backoffice solo conoce el slug de la organización tras el login
// (`auth-client.ts` nunca trae un `propertyId`), pero todas las rutas de staff de
// licitaciones (tenders/matching/go-no-go/checklist) SÍ lo exigen vía
// `requirePropertyMembership("propertyId")`. Sin este endpoint, el panel web
// (Fase 7) no tenía ningún camino real para resolver ese propertyId -- era el
// primer eslabón faltante antes que cualquier pantalla, no solo el checklist.
import { Hono } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function licitacionesAdminRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/licitaciones/:orgSlug/admin/branches", authMiddleware(deps.env), dbSession(deps.engine));
  app.get("/v1/licitaciones/:orgSlug/admin/branches", async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const repo = deps.licitacionesRepo(c.get("db"));
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);

    // Mismo patrón exacto que GET /v1/citas/:orgSlug/admin/branches: resuelve la
    // org por slug + verifica membership vía `coreRepo.findMembershipsByUserId` —
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
