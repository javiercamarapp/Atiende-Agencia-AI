// Fase 8 restaurantes — HTTP end-to-end de repartidor-orders.ts (superficie real del
// rol "repartidor": acotada a SUS pedidos asignados, nunca gestión) + el dispatch
// nuevo de admin-orders.ts (PATCH .../admin/orders/:orderId/assign-repartidor).
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

describe("GET /v1/restaurantes/:propertyId/repartidor/orders", () => {
  it("el repartidor ve SOLO sus propios pedidos asignados -- nunca los de otro repartidor ni el resto de la organización", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const mio = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", total: 100 });
    const deNadie = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 50 });
    ctx.restaurantesRepo.seedOrder(mio);
    ctx.restaurantesRepo.seedOrder(deNadie);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, mio.id, ctx.staff.repartidor.id, null);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ id: string }> };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]?.id).toBe(mio.id);
  });

  it("owner/staff (MANAGER_ROLES) -> 403 -- esta ruta es EXCLUSIVA de repartidor", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);

    const asOwner = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders`, authedGet(ctx.staff.owner.token));
    expect(asOwner.status).toBe(403);
    const asStaff = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders`, authedGet(ctx.staff.staffSucursalA.token));
    expect(asStaff.status).toBe(403);
  });
});

describe("GET /v1/restaurantes/:propertyId/repartidor/orders/:orderId", () => {
  it("el repartidor puede leer la ficha de SU pedido asignado", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { order: { id: string } }).order.id).toBe(order.id);
  });

  it("un pedido que NO le fue asignado -- 404 uniforme (nunca distingue \"no existe\" de \"no es tuyo\")", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const ajeno = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(ajeno);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${ajeno.id}`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/restaurantes/:propertyId/repartidor/orders/:orderId/status", () => {
  it("preparando -> en_camino -> entregado, el avance real de una entrega", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
    const app = buildApp(ctx.deps);

    const enCamino = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "en_camino" }, "PATCH"));
    expect(enCamino.status).toBe(200);
    expect(((await enCamino.json()) as { order: { status: string } }).order.status).toBe("en_camino");

    const entregado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "entregado" }, "PATCH"));
    expect(entregado.status).toBe(200);
    expect(((await entregado.json()) as { order: { status: string } }).order.status).toBe("entregado");
  });

  it('"problema" sin incidentNote -> 409, nunca cambia el estado; con incidentNote real -> 200 y lo persiste', async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
    const app = buildApp(ctx.deps);

    const sinNota = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "problema" }, "PATCH"));
    expect(sinNota.status).toBe(409);

    const conNota = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`,
      authedJson(ctx.staff.repartidor.token, { status: "problema", incidentNote: "El cliente no contesta." }, "PATCH"),
    );
    expect(conNota.status).toBe(200);
    const body = (await conNota.json()) as { order: { status: string; incidentNote: string | null } };
    expect(body.order.status).toBe("problema");
    expect(body.order.incidentNote).toBe("El cliente no contesta.");
  });

  it('un repartidor NUNCA puede fijar "preparando"/"cancelado"/"completado" (movimientos de gestión) -- 409', async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "pending", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "preparando" }, "PATCH"));
    expect(res.status).toBe(409);
  });

  it("un pedido asignado a OTRO repartidor -- 404, nunca lo puede tocar", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    // Nunca se asigna a ctx.staff.repartidor -- queda sin asignar / ajeno.
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "en_camino" }, "PATCH"));
    expect(res.status).toBe(404);
  });

  it("status desconocido en el body -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "no-existe" }, "PATCH"));
    expect(res.status).toBe(400);
  });

  it("owner (MANAGER_ROLES) -> 403 -- esta ruta es EXCLUSIVA de repartidor", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);

    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "en_camino" }, "PATCH"));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /v1/restaurantes/:propertyId/admin/orders/:orderId/assign-repartidor", () => {
  it("owner despacha un pedido a un repartidor real de la organización", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`,
      authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.repartidor.id, estimatedDeliveryAt: "2026-09-14T20:00:00.000Z" }, "PATCH"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { order: { assignedRepartidorId: string | null; estimatedDeliveryAt: string | null } };
    expect(body.order.assignedRepartidorId).toBe(ctx.staff.repartidor.id);
    expect(body.order.estimatedDeliveryAt).toBe("2026-09-14T20:00:00.000Z");

    // El repartidor ya lo ve en su propia lista tras el dispatch.
    const listado = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders`, authedGet(ctx.staff.repartidor.token));
    const listadoBody = (await listado.json()) as { orders: Array<{ id: string }> };
    expect(listadoBody.orders.map((o) => o.id)).toContain(order.id);
  });

  it("asignar un uuid que NO es repartidor de esta organización (ej. staff de gestión) -> 400, nunca despacha", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`,
      authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.staffSucursalA.id }, "PATCH"),
    );
    expect(res.status).toBe(400);
  });

  it("asignar un uuid de un repartidor de OTRA organización -> 400", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`,
      authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.otroOrgOwner.id }, "PATCH"),
    );
    expect(res.status).toBe(400);
  });

  it("repartidor -- 403, nunca puede autodespacharse", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", total: 100 });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);

    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`,
      authedJson(ctx.staff.repartidor.token, { repartidorId: ctx.staff.repartidor.id }, "PATCH"),
    );
    expect(res.status).toBe(403);
  });
});
