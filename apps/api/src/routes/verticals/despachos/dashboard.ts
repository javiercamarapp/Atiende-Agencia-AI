// Dashboard gerencial de despachos (D-01).
//   GET /despachos/:propertyId/dashboard        -> KPIs y anomalías de UN cliente (contribuyente).
//   GET /v1/despachos/:orgSlug/dashboard        -> consolidado del despacho + ranking de clientes.
//
// Solo lectura y solo datos reales del modelo (CFDI, cartera/cobranza, revisiones,
// vencimientos, cierre mensual): ver `@atiende/domain-despachos::dashboard/` para qué se
// calcula y qué NO existe en el modelo (asignación por staff, CFDI emitidos, nómina
// procesada, asientos). Compatible con la base sin migrar: cada fuente se lee en su propio
// SAVEPOINT y, si la tabla/columna aún no existe, el bloque sale `null` y se declara en
// `fuentesNoDisponibles` (nunca un 500). Sin migración nueva.
//
// Autorización: la ruta por cliente usa `requirePropertyMembership` (igual que el resto de
// rutas de staff). La ruta de organización replica el patrón de `GET .../admin/branches`:
// resuelve la org por slug, exige membership real (`coreRepo.findMembershipsByUserId`) y
// limita el consolidado a las properties VISIBLES para ese miembro (`propertyIds`); además
// toda lectura corre en la sesión RLS del usuario, así que un cliente fuera de su alcance
// jamás aparecería aunque se pidiera.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { VER_DASHBOARD_ROLES, consolidarKpisDespacho, leerKpisCliente } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";

/** Tope de clientes que consolida una sola petición (cada uno cuesta ~6 lecturas). */
export const MAX_CLIENTES_DASHBOARD = 100;

export function despachosDashboardRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/dashboard", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.get("/despachos/:propertyId/dashboard", async (c) => {
    assertVerticalRole(c, VER_DASHBOARD_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const branches = await repo.listPropertiesForOrganization(c.get("organizationId"));
    const nombre = branches.find((b) => b.propertyId === propertyId)?.name ?? "Contribuyente";
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(repo, propertyId));
    return c.json(await leerKpisCliente(repo, { propertyId, nombre, hoy }));
  });

  app.use("/v1/despachos/:orgSlug/dashboard", authMiddleware(deps.env), dbSession(deps.engine));
  app.get("/v1/despachos/:orgSlug/dashboard", async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const repo = deps.despachosRepo(c.get("db"));
    const org = await repo.findOrganizationBySlug(orgSlug);
    if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);

    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    const membership = memberships.find((m) => m.organizationId === org.id);
    if (!membership) throw Errors.forbidden("No perteneces a esta organización.");
    if (!(VER_DASHBOARD_ROLES as readonly string[]).includes(membership.verticalRole)) {
      throw Errors.forbidden(`Tu rol (${membership.verticalRole}) no puede realizar esta acción.`);
    }

    const todas = await repo.listPropertiesForOrganization(org.id);
    const visibles = membership.propertyIds === null ? todas : todas.filter((b) => membership.propertyIds!.includes(b.propertyId));
    const acotadas = visibles.slice(0, MAX_CLIENTES_DASHBOARD);

    // Un cliente a la vez sobre la misma sesión (una sola conexión/transacción por request).
    const clientes = [];
    for (const b of acotadas) {
      const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(repo, b.propertyId));
      clientes.push(await leerKpisCliente(repo, { propertyId: b.propertyId, nombre: b.name, hoy }));
    }

    return c.json({
      organizacion: { slug: org.slug, nombre: org.name },
      totalClientesVisibles: visibles.length,
      truncado: visibles.length > acotadas.length,
      ...consolidarKpisDespacho(clientes),
    });
  });

  return app;
}
