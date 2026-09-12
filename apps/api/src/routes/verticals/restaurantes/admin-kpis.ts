// Fase 3 restaurantes — dashboards de KPIs (ver diseño §2). PRIMERAS rutas de staff
// autenticado de este vertical: hasta ahora `public.ts`/`voice-tools.ts`/`whatsapp.ts`
// eran las únicas, y las tres son públicas o protegidas por `x-atiende-tool-secret`
// (ver README.md del directorio). Mismo patrón reusado de `hoteles/folios.ts` /
// `rentas/finanzas.ts`, SIN tocar `@atiende/core-auth`: monta sobre `:propertyId` con
// `requirePropertyMembership("propertyId")` (resuelve `organizationId` real desde la
// membership verificada) y, dentro de cada handler, `assertVerticalRole(c,
// MANAGER_ROLES)` — igual que el acceso a ClientesSection/AdminDashboard en el origen
// (excluye `repartidor`).
//
// Alcance por membership, no solo por org (diferencia real de fusion vs. origen): si la
// membership del staff trae `propertyIds` restringido (no null), las 3 rutas de ventas/
// canales se acotan a esas properties — nunca a toda la organización. `requirePropertyMembership`
// ya resuelve/verifica la membership contra `:propertyId`, pero deliberadamente angosta
// el contexto a `[propertyId]` (ver @atiende/core-auth/src/middleware.ts — correcto
// para folios, que solo tocan ESA property); para el alcance MÁS AMPLIO que un KPI
// org-wide necesita, se reconsulta la membership completa vía
// `deps.coreRepo.findMembershipsByUserId` (el mismo puerto, ya production-ready, que
// usan las rutas de login) — nunca vía una query cruda nueva contra `c.get("db")`.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  MANAGER_ROLES,
  isStatsPeriod,
  getSalesKpis,
  getSalesTrendKpis,
  getChannelKpis,
  getCustomerKpis,
} from "@atiende/domain-restaurantes";
import type { StatsPeriod } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";
import type { Context } from "hono";

async function resolveEffectivePropertyIds(deps: AppDeps, c: Context<CoreAuthHonoEnv>, organizationId: string, branchId: string | null): Promise<readonly string[] | null> {
  const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
  const membership = memberships.find((m) => m.organizationId === organizationId);
  // Fallback de defensa en profundidad: si por alguna razón la membership completa no
  // aparece aquí (nunca debería, ver comentario de archivo — coreRepo/engine leen la
  // MISMA tabla real en producción), nunca se ensancha el alcance más allá de la única
  // property que `requirePropertyMembership` ya verificó para esta request.
  const verifiedPropertyId = c.req.param("propertyId") ?? "";
  const membershipScope: readonly string[] | null = membership ? membership.propertyIds : [verifiedPropertyId];

  if (branchId === null) return membershipScope;

  const branches = await deps.restaurantesRepo.listBranchesForOrganization(organizationId);
  if (!branches.some((b) => b.propertyId === branchId)) {
    throw Errors.validation("branchId no pertenece a esta organización (o no está activo).");
  }
  if (membershipScope !== null && !membershipScope.includes(branchId)) {
    throw Errors.forbidden("No tienes acceso a esta sucursal.");
  }
  return [branchId];
}

function parsePeriod(raw: string | undefined): StatsPeriod {
  if (!raw || !isStatsPeriod(raw)) {
    throw Errors.validation("period: se esperaba uno de today|7|30|90|180|365|historico.");
  }
  return raw;
}

function parseBranchId(raw: string | undefined): string | null {
  if (raw === undefined || raw === "") return null;
  if (raw.length > 200) throw Errors.validation("branchId inválido.");
  return raw;
}

export function restaurantesAdminKpisRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repo = deps.restaurantesRepo;

  app.use("/v1/restaurantes/:propertyId/admin/kpis/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/v1/restaurantes/:propertyId/admin/kpis/sales", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const period = parsePeriod(c.req.query("period"));
    const branchId = parseBranchId(c.req.query("branchId"));
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, branchId);

    const summary = await getSalesKpis(repo, organizationId, propertyIds, period, new Date());
    return c.json({
      revenue: summary.revenue,
      orders: summary.orders,
      customers: summary.customers,
      averageOrder: summary.averageOrder,
      revenueChangePct: summary.revenueChangePct,
      ordersChangePct: summary.ordersChangePct,
      customersChangePct: summary.customersChangePct,
      avgOrderChangePct: summary.avgOrderChangePct,
      periodLabel: summary.periodLabel,
    });
  });

  app.get("/v1/restaurantes/:propertyId/admin/kpis/sales/trend", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const period = parsePeriod(c.req.query("period"));
    const branchId = parseBranchId(c.req.query("branchId"));
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, branchId);

    // `firstOrderAt` solo importa para 'historico' (granularidad adaptativa según la
    // antigüedad real del primer pedido) — MIN(created_at) directo en Postgres, mismo
    // espíritu que la consulta aparte de `actualizarEstadisticasYTendencia` (nunca
    // sobre un array de pedidos ya truncado).
    const firstOrderAt = period === "historico" ? await repo.getFirstOrderCreatedAt(organizationId, propertyIds) : null;

    const buckets = await getSalesTrendKpis(repo, organizationId, propertyIds, period, new Date(), firstOrderAt);
    return c.json({ buckets: buckets.map((b) => ({ label: b.label, revenue: b.revenue, orders: b.orders })) });
  });

  app.get("/v1/restaurantes/:propertyId/admin/kpis/channels", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const branchId = parseBranchId(c.req.query("branchId"));
    const propertyIds = await resolveEffectivePropertyIds(deps, c, organizationId, branchId);

    const kpis = await getChannelKpis(repo, organizationId, propertyIds);
    return c.json(kpis);
  });

  app.get("/v1/restaurantes/:propertyId/admin/kpis/customers", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const organizationId = c.get("organizationId");
    const kpis = await getCustomerKpis(repo, organizationId);
    return c.json({
      totalCustomers: kpis.totalCustomers,
      averageOrderValue: kpis.averageOrderValue,
      recurringCustomerPct: kpis.recurringCustomerPct,
      topCustomer: kpis.topCustomer,
      avgDaysSinceLastOrder: kpis.avgDaysSinceLastOrder,
      tierDistribution: kpis.tierDistribution,
    });
  });

  // Helper de descubrimiento de sucursal — NO es un KPI (no está en la lista del
  // diseño §2), pero es plumbing mínimo indispensable para que la UI del §3 pueda
  // siquiera llamar a las rutas de arriba: estas cuelgan de `:propertyId` (mismo
  // contrato que hoteles/rentas — ver diseño §2, "no hace falta un middleware
  // org-wide"), pero la sesión de login (`LoginSession.organizations`, ver
  // apps/web/src/lib/auth-client.ts) nunca trae un propertyId — solo
  // {id, slug, nombre, vertical, rol} —, así que el dashboard necesita resolver AL
  // MENOS una property real de esa organización antes de poder pedir KPIs. Reusa
  // exactamente el mismo patrón de "resolver org por slug + verificar membership vía
  // coreRepo" que ya usa POST /auth/select-org — ninguna superficie de seguridad
  // nueva. Sin filtro de rol (MANAGER_ROLES): la lista de sucursales no es sensible
  // (el propio checkout público ya la expone indirectamente vía el agente de
  // WhatsApp) y hasta un `repartidor` necesita saber en cuál está.
  app.use("/v1/restaurantes/:orgSlug/admin/branches", authMiddleware(deps.env));
  app.get("/v1/restaurantes/:orgSlug/admin/branches", async (c) => {
    const org = await deps.restaurantesRepo.findOrganizationBySlug(c.req.param("orgSlug"));
    if (!org) throw Errors.notFound(`Restaurante "${c.req.param("orgSlug")}" no encontrado.`);

    const memberships = await deps.coreRepo.findMembershipsByUserId(c.get("userId"));
    if (!memberships.some((m) => m.organizationId === org.id)) {
      throw Errors.forbidden("No perteneces a esta organización.");
    }

    const branches = await deps.restaurantesRepo.listBranchesForOrganization(org.id);
    return c.json({ branches: branches.map((b) => ({ propertyId: b.propertyId, name: b.name, slug: b.slug })) });
  });

  return app;
}
