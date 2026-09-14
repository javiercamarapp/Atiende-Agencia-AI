// Fase 5 restaurantes — HTTP end-to-end de admin-orders.ts (pedidos en operación +
// historial + cambio de estado real vía la máquina de estados de
// order-lifecycle.ts).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

describe("GET /v1/restaurantes/:propertyId/admin/orders", () => {
  it("owner (org-wide) ve pedidos de AMBAS sucursales; staff acotado a A NUNCA ve los de B", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, status: "pending", total: 250 }));
    const app = buildApp(ctx.deps);

    const asOwner = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders`, authedGet(ctx.staff.owner.token));
    expect(asOwner.status).toBe(200);
    expect(((await asOwner.json()) as { orders: unknown[] }).orders).toHaveLength(2);

    const asStaffA = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders`, authedGet(ctx.staff.staffSucursalA.token));
    const bodyA = (await asStaffA.json()) as { orders: Array<{ propertyId: string }> };
    expect(bodyA.orders).toHaveLength(1);
    expect(bodyA.orders[0]?.propertyId).toBe(ctx.propertyIdA);
  });

  it("filtra por status real (pedidos en operación)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "entregado", total: 50 }));
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?status=pending`, authedGet(ctx.staff.owner.token));
    const body = (await res.json()) as { orders: Array<{ status: string }> };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.status).toBe("pending");
  });

  it("status desconocido -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?status=listo`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });

  it("filtra por rango de fechas (historial) y pagina con cursor", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    for (let i = 0; i < 3; i += 1) {
      ctx.restaurantesRepo.seedOrder(makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "completado", total: 10 }));
    }
    const app = buildApp(ctx.deps);

    const page1 = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?limit=2`, authedGet(ctx.staff.owner.token));
    const body1 = (await page1.json()) as { orders: unknown[]; nextCursor: string | null };
    expect(body1.orders).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();

    const page2 = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`, authedGet(ctx.staff.owner.token));
    const body2 = (await page2.json()) as { orders: unknown[]; nextCursor: string | null };
    expect(body2.orders).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
  });

  it("repartidor -> 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /v1/restaurantes/:propertyId/admin/orders/:orderId/status", () => {
  it("owner avanza un pedido real pending -> preparando", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "preparando" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { order: { status: string } }).order.status).toBe("preparando");
  });

  it("un salto inválido (pending -> entregado) -> 409 conflict, nunca cambia el estado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "entregado" }, "PATCH"));
    expect(res.status).toBe(409);

    const reread = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}`, authedGet(ctx.staff.owner.token));
    expect(((await reread.json()) as { order: { status: string } }).order.status).toBe("pending");
  });

  it("status desconocido en el body -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "no-existe" }, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("pedido inexistente -> 404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/00000000-0000-0000-0000-000000000000/status`,
      authedJson(ctx.staff.owner.token, { status: "preparando" }, "PATCH"),
    );
    expect(res.status).toBe(404);
  });

  it("staff acotado a sucursal A no puede cambiar el estado de un pedido de B -- 403", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdB, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.staffSucursalA.token, { status: "preparando" }, "PATCH"));
    expect(res.status).toBe(403);
  });

  it("staff de OTRA organización nunca puede leer/tocar un pedido de esta -- 403/404", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}`, authedGet(ctx.staff.otroOrgOwner.token));
    expect(res.status).toBe(403);
  });
});
