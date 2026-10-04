// QA R1 (restaurantes) features-04, 05a/b/c y 08: regresion del back-office por HTTP real sobre repos en memoria.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;

describe("back-office: disponibilidad por sucursal y despacho a repartidor", () => {
  // QA-restaurantes-R1-features-04 (P3): `isAvailable: Boolean(raw.isAvailable)` -> el string "false" ACTIVA el producto.
  it('QA-restaurantes-R1-features-04: isAvailable "false" (string) -> 400 o producto NO disponible (hoy queda disponible)', async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await json(await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/products`, authedJson(ctx.staff.owner.token, { name: "Agua de Jamaica", price: 35 })));
    const res = await app.request(
      `/v1/restaurantes/${ctx.propertyIdA}/admin/products/${created.product.id}/branch-availability`,
      authedJson(ctx.staff.owner.token, { price: 35, isAvailable: "false" }, "PATCH"),
    );
    if (res.status === 400) return;
    expect((await json(res)).branch.isAvailable).toBe(false);
  });

  // QA-restaurantes-R1-features-05 (P2): assign-repartidor no mira estado ni canal. Se puede despachar un pedido
  // PARA RECOGER (o ya cancelado/entregado); despues el repartidor lo marca "en_camino" (su ruta no aplica la
  // regla de canal que si aplica la del gerente) y el comensal recibe "tu pedido va en camino" de un pedido que
  // iba a recoger en mostrador.
  it("QA-restaurantes-R1-features-05a: asignar repartidor a un pedido PARA RECOGER -> 409/400 (hoy 200)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", notes: "Canal: recoger en sucursal.", canal: "recoger" } as Parameters<typeof makeOrder>[0]);
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`, authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.repartidor.id }, "PATCH"));
    expect([400, 409]).toContain(res.status);
  });

  it("QA-restaurantes-R1-features-05b: asignar repartidor a un pedido CANCELADO -> 409/400 (hoy 200 y aparece en la lista del repartidor)", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "cancelado" });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/assign-repartidor`, authedJson(ctx.staff.owner.token, { repartidorId: ctx.staff.repartidor.id }, "PATCH"));
    expect([400, 409]).toContain(res.status);
  });

  it('QA-restaurantes-R1-features-05c: el repartidor NO puede marcar "en_camino" un pedido para recoger (el gerente si esta bloqueado)', async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", notes: "Canal: recoger en sucursal.", canal: "recoger" } as Parameters<typeof makeOrder>[0]);
    ctx.restaurantesRepo.seedOrder(order);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "en_camino" }, "PATCH"));
    expect(res.status).toBe(409);
  });

  it('PASA (contraste del 05c): el GERENTE no puede marcar "en_camino" un pedido para recoger -> 409', async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", notes: "Canal: recoger en sucursal.", canal: "recoger" } as Parameters<typeof makeOrder>[0]);
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, { status: "en_camino" }, "PATCH"));
    expect(res.status).toBe(409);
  });
});

describe("back-office: bandeja de notificaciones de pedidos", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // QA-restaurantes-R1-features-08 (P3): para staff acotado a sucursales, el acknowledge verifica visibilidad con
  // `listStaffOrderNotifications(..., { limit: 500 })` (las 500 MAS RECIENTES, reconocidas o no). Una notificacion
  // pendiente mas vieja que esas 500 ya no se puede reconocer (404) aunque sea de SU sucursal.
  it("QA-restaurantes-R1-features-08: staff de sucursal A reconoce una notificacion pendiente de A aunque haya 500 mas recientes", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const vieja = await ctx.restaurantesRepo.createStaffOrderNotification(ctx.organizationId, ctx.propertyIdA, randomUUID(), "order.created", "Pedido nuevo");
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    for (let i = 0; i < 500; i++) {
      await ctx.restaurantesRepo.createStaffOrderNotification(ctx.organizationId, ctx.propertyIdA, randomUUID(), "order.created", "Pedido nuevo");
    }
    vi.useRealTimers();
    const app = buildApp(ctx.deps);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/order-notifications/${vieja.id}/acknowledge`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"));
    expect(res.status).toBe(200);
  });
});

// QA-restaurantes-R1-viaje-11: cierre administrativo (entregado -> completado) e incidencia posterior a la entrega con nota.
describe("back-office: entregado -> completado / incidencia con nota", () => {
  async function setup() {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "entregado" });
    ctx.restaurantesRepo.seedOrder(order);
    const app = buildApp(ctx.deps);
    const patch = (body: object) => app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${order.id}/status`, authedJson(ctx.staff.owner.token, body, "PATCH"));
    return { ctx, order, patch };
  }

  it("el dueno cierra un pedido entregado como completado", async () => {
    const { patch } = await setup();
    const res = await patch({ status: "completado" });
    expect(res.status).toBe(200);
    expect((await json(res)).order.status).toBe("completado");
  });

  it("registra una incidencia posterior a la entrega y guarda la nota", async () => {
    const { patch, ctx, order } = await setup();
    const res = await patch({ status: "problema", incidentNote: "  El cliente reporta que faltó un refresco  " });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.order.status).toBe("problema");
    expect(body.order.incidentNote).toBe("El cliente reporta que faltó un refresco");
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, order.id))?.incidentNote).toBe("El cliente reporta que faltó un refresco");
  });

  it("la nota se valida: vacia, de otro tipo, demasiado larga o con un estado distinto de problema -> 400", async () => {
    const { patch } = await setup();
    expect((await patch({ status: "problema", incidentNote: "   " })).status).toBe(400);
    expect((await patch({ status: "problema", incidentNote: 5 })).status).toBe(400);
    expect((await patch({ status: "problema", incidentNote: "x".repeat(2001) })).status).toBe(400);
    expect((await patch({ status: "completado", incidentNote: "no aplica" })).status).toBe(400);
  });

  it("un pedido completado no se puede marcar como incidencia (409)", async () => {
    const { patch } = await setup();
    expect((await patch({ status: "completado" })).status).toBe(200);
    expect((await patch({ status: "problema", incidentNote: "tarde" })).status).toBe(409);
  });
});
