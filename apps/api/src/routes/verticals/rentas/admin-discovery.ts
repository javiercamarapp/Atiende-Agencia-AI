// Fase 12 rentas — helper de descubrimiento de organización/property, plumbing
// mínimo indispensable para que el panel web de staff (apps/web/src/verticals/rentas)
// pueda siquiera llamar al resto de rutas de este vertical: todas cuelgan de
// `:propertyId` (reservas.ts/bloqueos.ts/finanzas.ts/etc.), pero la sesión de login
// (`LoginSession.organizations`, ver apps/web/src/lib/auth-client.ts) nunca trae un
// propertyId — solo {id, slug, nombre, vertical, rol} —, así que el panel necesita
// resolver al menos una property real de esa organización antes de poder pedir nada.
// MISMO patrón exacto que `apps/api/src/routes/verticals/hoteles/admin-discovery.ts`
// (Fase 7 de ese vertical) — resuelto aquí para rentas por primera vez porque hasta
// esta fase ninguna ruta de rentas necesitaba ir de slug -> propertyId (todas las
// rutas de negocio ya reciben un propertyId real desde el diseño Fase 1).
//
// Sin filtro de rol (ADMIN_ROLES/etc.): la lista de properties de la propia
// organización no es sensible, cualquier miembro del staff necesita saber en cuál
// está — mismo criterio que `GET /v1/hoteles/:orgSlug/admin/propiedades`.
import { Hono } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

export function rentasAdminDiscoveryRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  // Sin `requirePropertyMembership` (no hay propertyId en el path todavía): la
  // autorización real es "pertenece a esta organización", verificada abajo vía
  // `deps.coreRepo.findMembershipsByUserId` — mismo criterio que el helper de
  // hoteles.
  app.use("/v1/rentas/:orgSlug/admin/propiedades", authMiddleware(deps.env), dbSession(deps.engine));

  app.get("/v1/rentas/:orgSlug/admin/propiedades", async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const repo = deps.rentasRepo(c.get("db"));
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org) throw Errors.notFound(`Organización de rentas "${orgSlug}" no encontrada.`);

    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    if (!memberships.some((m) => m.organizationId === org.id)) {
      throw Errors.forbidden("No perteneces a esta organización.");
    }

    const propiedades = await repo.listPropertiesForOrganization(org.id);
    return c.json({ propiedades: propiedades.map((p) => ({ propertyId: p.propertyId, nombre: p.name })) });
  });

  return app;
}
