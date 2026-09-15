// Fase 5 restaurantes — back-office CORE: ficha de sucursal (ver diseño §1.2).
// Alcance por membership (no solo por organización), mismo criterio que
// admin-kpis.ts: un staff con `propertyIds` restringido nunca ve/edita una
// sucursal fuera de su alcance, aunque la ruta cuelgue de OTRA `:propertyId` de la
// misma organización que sí le pertenece.
//
// Deliberadamente NO expone "crear sucursal" ni "activar/desactivar sucursal": esos
// dos requieren escribir `core.property` (nombre/status), tabla compartida por
// TODAS las verticales cuyo GRANT de escritura hoy es exclusivo de `service_role`
// (ver migrations/007_admin_backoffice_grants_and_policies.sql, comentario de
// cabecera, para el detalle completo de por qué eso queda fuera de esta fase).
// `PATCH .../sucursales/:branchId` edita SOLO lo que vive en
// `restaurantes.branch_detail` (teléfono/dirección/coordenadas/slug/orden).
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MANAGER_ROLES } from "@atiende/domain-restaurantes";
import type { Branch } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import { logEvent } from "../../../logger.ts";
import type { AppDeps } from "../../../deps.ts";
import { resolveEffectivePropertyIds } from "./admin-scope.ts";

function serializeBranch(b: Branch) {
  return { propertyId: b.propertyId, name: b.name, slug: b.slug, status: b.status, phone: b.phone, address: b.address, lat: b.lat, lng: b.lng };
}

interface BranchDetailBody {
  readonly phone?: unknown;
  readonly address?: unknown;
  readonly lat?: unknown;
  readonly lng?: unknown;
  readonly slug?: unknown;
  readonly displayOrder?: unknown;
}

function optionalNullableString(value: unknown, field: string, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw Errors.validation(`${field}: se esperaba un texto de hasta ${maxLength} caracteres.`);
  }
  return value;
}

function optionalNullableCoordinate(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -180 || value > 180) {
    throw Errors.validation(`${field}: se esperaba una coordenada numérica válida o null.`);
  }
  return value;
}

function optionalSlug(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 100) {
    throw Errors.validation("slug: solo minúsculas, dígitos y guiones.");
  }
  return value;
}

function optionalDisplayOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw Errors.validation("displayOrder: se esperaba un entero >= 0.");
  }
  return value;
}

async function assertBranchInScope(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string, branchId: string): Promise<void> {
  const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
  if (scope !== null && !scope.includes(branchId)) {
    throw Errors.forbidden("No tienes acceso a esta sucursal.");
  }
}

export function restaurantesAdminBranchesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/admin/sucursales", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/sucursales/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/v1/restaurantes/:propertyId/admin/sucursales", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const repo = deps.restaurantesRepo(c.get("db"));
    const scope = await resolveEffectivePropertyIds(deps, c, organizationId, null);
    const all = await repo.listBranchesForOrganizationAdmin(organizationId);
    const visible = scope === null ? all : all.filter((b) => scope.includes(b.propertyId));
    return c.json({ branches: visible.map(serializeBranch) });
  });

  app.get("/v1/restaurantes/:propertyId/admin/sucursales/:branchId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const branchId = c.req.param("branchId");
    await assertBranchInScope(deps, c, organizationId, branchId);
    const repo = deps.restaurantesRepo(c.get("db"));
    const branch = await repo.findBranchById(organizationId, branchId);
    if (!branch) throw Errors.notFound("Sucursal no encontrada.");
    return c.json({ branch: serializeBranch(branch) });
  });

  app.patch("/v1/restaurantes/:propertyId/admin/sucursales/:branchId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const branchId = c.req.param("branchId");
    await assertBranchInScope(deps, c, organizationId, branchId);
    const repo = deps.restaurantesRepo(c.get("db"));

    const raw = await readJsonCapped<BranchDetailBody>(c.req.raw, 8 * 1024);
    const patch = {
      phone: optionalNullableString(raw.phone, "phone", 40),
      address: optionalNullableString(raw.address, "address", 500),
      lat: optionalNullableCoordinate(raw.lat, "lat"),
      lng: optionalNullableCoordinate(raw.lng, "lng"),
      slug: optionalSlug(raw.slug),
      displayOrder: optionalDisplayOrder(raw.displayOrder),
    };
    const updated = await repo.updateBranchDetail(organizationId, branchId, patch);
    if (!updated) throw Errors.notFound("Sucursal no encontrada.");
    logEvent(c, "info", "restaurantes_admin_sucursal_actualizada", { actorUserId: c.get("userId"), organizationId, branchId });
    return c.json({ branch: serializeBranch(updated) });
  });

  return app;
}
