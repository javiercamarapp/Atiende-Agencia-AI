// Fase 5 restaurantes — HTTP end-to-end de admin-customers.ts (listado + ficha).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

describe("GET /v1/restaurantes/:propertyId/admin/customers", () => {
  it("lista clientes reales de la organización, nunca los de otra", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    await ctx.restaurantesRepo.upsertCustomer(ctx.otherOrganizationId, "9993334444", "Cliente ajeno");
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customers: Array<{ name: string | null }> };
    expect(body.customers.some((c) => c.name === "Ana Torres")).toBe(true);
    expect(body.customers.some((c) => c.name === "Cliente ajeno")).toBe(false);
  });

  it("search filtra por nombre/teléfono", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9995556666", "Beto López");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers?search=ana`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { customers: Array<{ name: string | null }> };
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0]?.name).toBe("Ana Torres");
  });

  it("repartidor -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });

  it("staff de OTRA organización -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/restaurantes/:propertyId/admin/customers/:customerId", () => {
  it("devuelve la ficha real (tier/direcciones/lo de siempre) — misma forma que lookupCustomer", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const customer = await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/${customer.id}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { customer: { isNew: boolean; name: string | null } };
    expect(body.customer.isNew).toBe(false);
    expect(body.customer.name).toBe("Ana Torres");
  });

  it("cliente inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/00000000-0000-0000-0000-000000000000`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(404);
  });

  it("un cliente de OTRA organización -> 404 (nunca se filtra por id ajeno)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const otherCustomer = await ctx.restaurantesRepo.upsertCustomer(ctx.otherOrganizationId, "9993334444", "Cliente ajeno");
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/customers/${otherCustomer.id}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(404);
  });
});
