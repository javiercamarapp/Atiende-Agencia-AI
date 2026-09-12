// Test de integración end-to-end (HTTP real vía app.request) de Fase 3 restaurantes —
// dashboards de KPIs. PRIMERAS rutas de staff autenticado de este vertical: cubre auth
// real, MANAGER_ROLES (excluye repartidor), aislamiento cross-tenant, y el alcance por
// membership restringida (propertyIds) vs. org-wide — la pieza que no existía en el
// origen (ver diseño Fase 3 §2).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

describe("GET /v1/restaurantes/:propertyId/admin/kpis/* — auth y roles", () => {
  it("exige un token (401 sin Authorization)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=30`);
    expect(res.status).toBe(401);
  });

  it("repartidor (fuera de MANAGER_ROLES) -> 403, aunque pertenezca a la property", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=30`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });

  it("staff de OTRA organización -> 403 al pedir KPIs de esta property (aislamiento cross-tenant real)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=30`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });

  it("period inválido/ausente -> 400 validation_error", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const missing = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales`, authedGet(ctx.staff.owner.token));
    expect(missing.status).toBe(400);
    const invalid = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=nunca`, authedGet(ctx.staff.owner.token));
    expect(invalid.status).toBe(400);
  });
});

describe("GET .../kpis/sales — agregado real, honestidad de null", () => {
  it("owner (org-wide) ve la suma de AMBAS sucursales", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, total: 100 }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, total: 250 }));
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=historico`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revenue: number; orders: number; periodLabel: string };
    expect(body.revenue).toBe(350);
    expect(body.orders).toBe(2);
    expect(body.periodLabel).toBe("todo el tiempo registrado");
  });

  it("staff acotado a la sucursal A (membership restringida) NUNCA ve los datos de B, aunque pida un KPI 'org-wide'", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, total: 100 }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, total: 250 }));
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=historico`, authedGet(ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revenue: number; orders: number };
    expect(body.revenue).toBe(100); // nunca 350 — la membership de este staff no incluye B.
    expect(body.orders).toBe(1);
  });

  it("branchId filtra a una sola sucursal dentro del alcance permitido", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, total: 100 }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, total: 250 }));
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=historico&branchId=${ctx.propertyIdB}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { revenue: number }).revenue).toBe(250);
  });

  it("branchId fuera del alcance de la membership restringida -> 403 (nunca 200 con datos ajenos)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=historico&branchId=${ctx.propertyIdB}`, authedGet(ctx.staff.staffSucursalA.token));
    expect(res.status).toBe(403);
  });

  it("branchId que no pertenece a esta organización -> 400 (nunca se confía en el query param a ciegas)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=historico&branchId=${ctx.otherPropertyId}`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("sin ningún pedido: revenue/orders en 0 reales, pero los %s de cambio son null (nunca 0 fingido, salvo 'historico' que ya no compara)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales?period=30`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { revenue: number; revenueChangePct: number | null };
    expect(body.revenue).toBe(0);
    expect(body.revenueChangePct).toBe(0); // previous=0 y current=0 -> 0 real (no null: sí hay comparación, ambos ceros)
  });
});

describe("GET .../kpis/sales/trend", () => {
  it("devuelve un bucket por tramo, alineado con el periodo pedido", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, total: 100 }));
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/sales/trend?period=7`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { buckets: Array<{ label: string; revenue: number; orders: number }> };
    expect(body.buckets).toHaveLength(7);
    expect(body.buckets.reduce((s, b) => s + b.revenue, 0)).toBe(100);
  });
});

describe("GET .../kpis/channels — 'Impacto de tus agentes'", () => {
  it("desglosa voz/whatsapp y calcula adopción/ingreso IA", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, source: "web", total: 100 }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, source: "voice", total: 100, status: "completado" }));
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/channels`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalOrders: number; aiAdoptionPct: number | null; voice: { orders: number } };
    expect(body.totalOrders).toBe(2);
    expect(body.aiAdoptionPct).toBe(50);
    expect(body.voice.orders).toBe(1);
  });

  it("repartidor no puede leer canales (MANAGER_ROLES)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/channels`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });
});

describe("GET .../kpis/customers — 'Panorama de clientes' (org-wide siempre, sin branchId)", () => {
  it("agrega clientes de TODA la organización sin importar la property de la URL", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedCustomer({ id: "c1", organizationId: ctx.organizationId, phone: "9990000001", name: "Cliente 1", orderCount: 0 });
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, customerId: "c1", total: 80 }));
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/customers`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalCustomers: number; averageOrderValue: number | null };
    expect(body.totalCustomers).toBe(1);
    expect(body.averageOrderValue).toBe(80);
  });

  it("sin ningún cliente: null explícito, nunca $0/0% fingidos", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/kpis/customers`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { averageOrderValue: number | null; recurringCustomerPct: number | null; topCustomer: unknown };
    expect(body.averageOrderValue).toBeNull();
    expect(body.recurringCustomerPct).toBeNull();
    expect(body.topCustomer).toBeNull();
  });
});

describe("GET /v1/restaurantes/:orgSlug/admin/branches — helper de descubrimiento para el dashboard", () => {
  it("lista las sucursales activas de la organización del staff autenticado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/admin/branches", authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { branches: Array<{ propertyId: string; name: string; slug: string }> };
    expect(body.branches).toHaveLength(2);
    expect(body.branches.map((b) => b.slug).sort()).toEqual(["centro", "fco-montejo"]);
  });

  it("staff sin membership en esa organización -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/admin/branches", authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });

  it("sin token -> 401", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request("/v1/restaurantes/los-taquitos-de-pm/admin/branches");
    expect(res.status).toBe(401);
  });
});
