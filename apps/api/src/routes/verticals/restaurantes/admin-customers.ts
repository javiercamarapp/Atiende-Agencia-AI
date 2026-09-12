// Fase 5 restaurantes — back-office CORE: UI de administración de clientes (ver
// diseño §1.5). Nunca inventa campos nuevos — expone exactamente lo que
// `customers.ts::lookupCustomer`/`getCustomerDetailById` ya calculan (tier real por
// percentil, "lo de siempre" real, direcciones guardadas), mismo criterio que
// admin-kpis.ts con los KPIs de cliente. Los clientes son organization-wide (no
// por-sucursal, ver comentario de `getCustomerOverviewKpis` en repository.ts) — el
// `:propertyId` del path solo resuelve `organizationId` real vía
// `requirePropertyMembership`, igual que en las otras rutas de admin de esta fase.
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { MANAGER_ROLES, getCustomerDetailById } from "@atiende/domain-restaurantes";
import type { Customer } from "@atiende/domain-restaurantes";
import { Errors } from "../../../errors.ts";
import type { AppDeps } from "../../../deps.ts";

function serializeCustomer(cust: Customer) {
  return { id: cust.id, name: cust.name, phone: cust.phone, orderCount: cust.orderCount };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw Errors.validation("limit: se esperaba un entero entre 1 y 100.");
  return n;
}

export function restaurantesAdminCustomersRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/v1/restaurantes/:propertyId/admin/customers", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/v1/restaurantes/:propertyId/admin/customers/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.get("/v1/restaurantes/:propertyId/admin/customers", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const search = c.req.query("search") || undefined;
    if (search !== undefined && search.length > 160) throw Errors.validation("search: demasiado largo.");
    const limit = parseLimit(c.req.query("limit"));
    const cursor = c.req.query("cursor") || undefined;

    const page = await repo.listCustomers(c.get("organizationId"), { search, limit, cursor });
    return c.json({ customers: page.customers.map(serializeCustomer), nextCursor: page.nextCursor });
  });

  app.get("/v1/restaurantes/:propertyId/admin/customers/:customerId", async (c) => {
    assertVerticalRole(c, MANAGER_ROLES);
    const repo = deps.restaurantesRepo(c.get("db"));
    const detail = await getCustomerDetailById(repo, c.get("organizationId"), c.req.param("customerId"));
    if (!detail) throw Errors.notFound("Cliente no encontrado.");
    return c.json({ customer: detail });
  });

  return app;
}
