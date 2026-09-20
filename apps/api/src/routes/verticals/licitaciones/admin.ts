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
import type { Context } from "hono";
import { authMiddleware, dbSession } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { STAFF_INVITE_ROLES, TenantConfigNotMigratedError } from "@atiende/domain-licitaciones";
import type { LicitacionesTenantConfigPatch } from "@atiende/domain-licitaciones";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Resuelve org + membership real del caller para el slug de la URL — mismo
 * patrón exacto que `GET /v1/licitaciones/:orgSlug/admin/branches` de abajo
 * (sin propertyId: la configuración de zona horaria es a nivel de
 * ORGANIZACIÓN completa, licitaciones no tiene el concepto de zona horaria
 * por sucursal que sí tiene citas). Lanza 404/403 -- nunca deja pasar un
 * slug ajeno o inactivo. */
async function resolveOrgMembershipOrThrow(deps: AppDeps, c: Context<CoreAuthHonoEnv>) {
  // `?? ""` solo para satisfacer el tipo genérico de `Context` sin el literal de ruta
  // (mismo patrón `c.req.param(...)` que el resto de esta ruta, nunca alcanzable en la
  // práctica -- Hono siempre resuelve el parámetro real de la URL registrada) --
  // `findOrganizationBySlug("")` simplemente no encuentra ninguna fila -> 404.
  const orgSlug = c.req.param("orgSlug") ?? "";
  const repo = deps.licitacionesRepo(c.get("db"));
  const org = await repo.findOrganizationBySlug(orgSlug);
  if (!org || !org.isActive) throw Errors.notFound(`Negocio "${orgSlug}" no encontrado o inactivo.`);

  const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
  const membership = memberships.find((m) => m.organizationId === org.id);
  if (!membership) throw Errors.forbidden("No perteneces a esta organización.");

  return { repo, org, membership };
}

/** Mismo criterio EXACTO que `optionalTimeZone` de
 * `apps/api/src/routes/verticals/citas/admin.ts` (valida con el mismo
 * `Intl.DateTimeFormat` que `@atiende/core-tenancy::resolverZonaHorariaNegocio`
 * usa para "defensa en profundidad" al LEER — aquí se valida ANTES de
 * escribir, para un 400 claro en vez de que un valor basura degrade en
 * silencio al default de plataforma la próxima vez que se lea). A diferencia
 * de citas (`default_timezone not null`), aquí `null` explícito es un valor
 * VÁLIDO (borra la configuración -- vuelve al default de plataforma), `seen`
 * distingue "el campo no vino en el body" (deja el valor actual intacto) de
 * "vino `null` explícito" (mismo criterio `seen` que `optionalNullableReason`
 * de citas/admin.ts). */
function optionalNullableTimeZone(raw: Record<string, unknown>, field = "timezone"): { seen: boolean; value: string | null } {
  if (!(field in raw)) return { seen: false, value: null };
  const value = raw[field];
  if (value === null) return { seen: true, value: null };
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    throw Errors.validation(`${field}: se esperaba un texto de 1-100 caracteres, o null.`);
  }
  const trimmed = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    throw Errors.validation(`${field}: "${trimmed}" no es un timezone IANA válido (ej. "America/Mexico_City").`);
  }
  return { seen: true, value: trimmed };
}

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

  // ---- FASE 3 (producto) — zona horaria por negocio: UI mínima owner/admin ----
  // (licitaciones no modela un rol "gm" -- STAFF_INVITE_ROLES, el mismo umbral
  // owner/admin que ya rige altas de staff en admin-staff.ts, es el equivalente
  // real de esta vertical, ver roles.ts). Cualquier miembro de la organización
  // puede LEER (para que el panel muestre el valor vigente sin necesitar
  // permisos de escritura); solo owner/admin puede EDITAR.
  app.use("/v1/licitaciones/:orgSlug/admin/tenant-config", authMiddleware(deps.env), dbSession(deps.engine));

  app.get("/v1/licitaciones/:orgSlug/admin/tenant-config", async (c) => {
    const { repo, org } = await resolveOrgMembershipOrThrow(deps, c);
    const config = await repo.findTenantConfig(org.id);
    return c.json({ tenant_config: { organization_id: config.organizationId, timezone: config.timezone } });
  });

  app.patch("/v1/licitaciones/:orgSlug/admin/tenant-config", async (c) => {
    const { repo, org, membership } = await resolveOrgMembershipOrThrow(deps, c);
    // Segunda capa de autorización (además de la RLS de `licitaciones.tenant_config`,
    // migración 027, que ya exige `vertical_role in ('owner','admin')` como defensa en
    // profundidad real -- nunca solo una promesa de esta capa TS) -- mismo umbral
    // exacto que `STAFF_INVITE_ROLES` (owner/admin), rechazo explícito ANTES de tocar
    // la base para un 403 con mensaje propio en vez del genérico de RLS.
    if (!(STAFF_INVITE_ROLES as readonly string[]).includes(membership.verticalRole)) {
      throw Errors.forbidden("Solo el owner o un admin de la organización puede editar la zona horaria.");
    }

    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, 1024);
    const timezone = optionalNullableTimeZone(raw);
    const patch: LicitacionesTenantConfigPatch = timezone.seen ? { timezone: timezone.value } : {};

    try {
      const updated = await repo.upsertTenantConfig(org.id, patch);
      return c.json({ tenant_config: { organization_id: updated.organizationId, timezone: updated.timezone } });
    } catch (err) {
      if (err instanceof TenantConfigNotMigratedError) throw Errors.serviceUnavailable(err.message);
      throw err;
    }
  });

  return app;
}
