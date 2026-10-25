// Privacidad del telefono del cliente (T7): el repartidor nunca recibe el numero completo en listados/fichas (solo «Llamar», auditado y
// con tope por pedido) y el personal de mostrador (`staff`) ve el minimo de PII. Dueño y administrador siguen viendo todo.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";
import { MAX_LLAMADAS_POR_PEDIDO } from "../src/routes/verticals/restaurantes/repartidor-orders.ts";

const TELEFONO = "9991234567";

async function conPedidoAsignado(status: "preparando" | "en_camino" | "entregado" = "en_camino") {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status, customerPhone: TELEFONO, customerEmail: "cliente@example.test" });
  ctx.restaurantesRepo.seedOrder(order);
  await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
  return { ctx, order, app: buildApp(ctx.deps) };
}

describe("repartidor: el telefono del cliente viene enmascarado", () => {
  it("lista y ficha traen solo los ultimos 4 digitos", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    const lista = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders`, authedGet(ctx.staff.repartidor.token));
    const crudo = await lista.text();
    expect(crudo).not.toContain(TELEFONO);
    expect(crudo).toContain("4567");
    const ficha = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}`, authedGet(ctx.staff.repartidor.token));
    expect(await ficha.text()).not.toContain(TELEFONO);
  });

  it("el PATCH de estado tampoco devuelve el numero completo", async () => {
    const { ctx, order, app } = await conPedidoAsignado("preparando");
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, { status: "en_camino" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(TELEFONO);
  });
});

describe("POST repartidor/orders/:orderId/llamar", () => {
  const ruta = (ctx: { propertyIdA: string }, id: string) => `/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${id}/llamar`;

  it("entrega el numero en E.164 y deja una fila de acceso sin el numero", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    const res = await app.request(ruta(ctx, order.id), authedJson(ctx.staff.repartidor.token, {}, "POST"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ telefono: `+52${TELEFONO}` });
    const filas = ctx.restaurantesRepo.auditLog.filter((f) => f.entityType === "acceso" && f.action === "pii.llamar");
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ action: "pii.llamar", entityId: order.id, actorUserId: ctx.staff.repartidor.id });
    expect(JSON.stringify(filas)).not.toContain(TELEFONO);
  });

  it("owner y staff -> 403; sin sesion -> 401; pedido ajeno -> 404", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    expect((await app.request(ruta(ctx, order.id), authedJson(ctx.staff.owner.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(ruta(ctx, order.id), authedJson(ctx.staff.staffSucursalA.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(ruta(ctx, order.id), { method: "POST" })).status).toBe(401);
    const ajeno = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", customerPhone: TELEFONO });
    ctx.restaurantesRepo.seedOrder(ajeno);
    expect((await app.request(ruta(ctx, ajeno.id), authedJson(ctx.staff.repartidor.token, {}, "POST"))).status).toBe(404);
    expect(ctx.restaurantesRepo.auditLog.filter((f) => f.entityType === "acceso" && f.action === "pii.llamar")).toHaveLength(0);
  });

  it("un pedido ya entregado ya no entrega el numero (409) y no deja fila", async () => {
    const { ctx, order, app } = await conPedidoAsignado("entregado");
    const res = await app.request(ruta(ctx, order.id), authedJson(ctx.staff.repartidor.token, {}, "POST"));
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain(TELEFONO);
    expect(ctx.restaurantesRepo.auditLog.filter((f) => f.entityType === "acceso" && f.action === "pii.llamar")).toHaveLength(0);
  });

  it("tope por pedido: la llamada siguiente al maximo -> 429 sin el numero (todas quedan registradas)", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    for (let i = 0; i < MAX_LLAMADAS_POR_PEDIDO; i += 1) {
      expect((await app.request(ruta(ctx, order.id), authedJson(ctx.staff.repartidor.token, {}, "POST"))).status).toBe(200);
    }
    const sexta = await app.request(ruta(ctx, order.id), authedJson(ctx.staff.repartidor.token, {}, "POST"));
    expect(sexta.status).toBe(429);
    expect(await sexta.text()).not.toContain(TELEFONO);
    expect(ctx.restaurantesRepo.auditLog.filter((f) => f.entityType === "acceso" && f.action === "pii.llamar")).toHaveLength(MAX_LLAMADAS_POR_PEDIDO + 1);
  });

  it("sin la bitacora de accesos (097 sin aplicar) NO entrega el numero: 503", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    ctx.restaurantesRepo.bitacoraAccesoDisponible = false;
    const res = await app.request(ruta(ctx, order.id), authedJson(ctx.staff.repartidor.token, {}, "POST"));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(TELEFONO);
  });

  it("la misma llave: los primeros reintentos no consumen cupo, pero la misma llave 20 veces NO da telefono ilimitado (acaba en 429) y todo queda en la bitacora", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    const conLlave = (llave: string) => app.request(ruta(ctx, order.id), { ...authedJson(ctx.staff.repartidor.token, {}, "POST"), headers: { ...(authedJson(ctx.staff.repartidor.token, {}, "POST").headers as Record<string, string>), "Idempotency-Key": llave } });
    const estados: number[] = [];
    for (let i = 0; i < 20; i += 1) estados.push((await conLlave("llave-reintento-1")).status);
    expect(estados.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(estados.filter((e) => e === 200).length).toBeLessThanOrEqual(MAX_LLAMADAS_POR_PEDIDO + 3);
    expect(estados.at(-1)).toBe(429);
    // Cada entrega de telefono deja fila (los reintentos gratuitos tambien).
    expect(ctx.restaurantesRepo.auditLog.filter((f) => f.entityType === "acceso" && f.action === "pii.llamar")).toHaveLength(20);
  });

  it("el cupo es por pedido y por repartidor: otro pedido propio parte de cero; el pedido de OTRO repartidor de la misma sucursal es 404", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    for (let i = 0; i < MAX_LLAMADAS_POR_PEDIDO; i += 1) await app.request(ruta(ctx, order.id), authedJson(ctx.staff.repartidor.token, {}, "POST"));
    const otro = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", customerPhone: "9995550000" });
    ctx.restaurantesRepo.seedOrder(otro);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, otro.id, ctx.staff.repartidor.id, null);
    expect((await app.request(ruta(ctx, otro.id), authedJson(ctx.staff.repartidor.token, {}, "POST"))).status).toBe(200);
    const deOtroRepartidor = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", customerPhone: "9995551111" });
    ctx.restaurantesRepo.seedOrder(deOtroRepartidor);
    await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, deOtroRepartidor.id, ctx.staff.admin.id, null);
    const res = await app.request(ruta(ctx, deOtroRepartidor.id), authedJson(ctx.staff.repartidor.token, {}, "POST"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("9995551111");
  });

  it("owner/admin leen las filas en la bitacora (tipo=acceso); staff no", async () => {
    const { ctx, order, app } = await conPedidoAsignado();
    await app.request(ruta(ctx, order.id), authedJson(ctx.staff.repartidor.token, {}, "POST"));
    const ver = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?tipo=acceso`, authedGet(ctx.staff.owner.token));
    expect(ver.status).toBe(200);
    const cuerpo = (await ver.json()) as { items: Array<{ action: string }> };
    expect(cuerpo.items.map((i) => i.action)).toContain("pii.llamar");
    expect((await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/auditoria?tipo=acceso`, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
  });
});

describe("staff (cajero/encargado): minimo de PII", () => {
  it("pedido vivo: telefono completo; pedido terminado: enmascarado y sin correo; owner ve todo", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const vivo = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "preparando", customerPhone: TELEFONO, customerEmail: "vivo@example.test" });
    const cerrado = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "entregado", customerPhone: "9997654321", customerEmail: "cerrado@example.test" });
    ctx.restaurantesRepo.seedOrder(vivo);
    ctx.restaurantesRepo.seedOrder(cerrado);
    const app = buildApp(ctx.deps);
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/orders`;

    const comoStaff = await app.request(`${base}/${vivo.id}`, authedGet(ctx.staff.staffSucursalA.token));
    const vistoVivo = ((await comoStaff.json()) as { order: { customerPhone: string; customerEmail: string | null } }).order;
    expect(vistoVivo.customerPhone).toBe(TELEFONO);
    expect(vistoVivo.customerEmail).toBeNull();

    const cerradoStaff = await app.request(`${base}/${cerrado.id}`, authedGet(ctx.staff.staffSucursalA.token));
    const texto = await cerradoStaff.text();
    expect(texto).not.toContain("9997654321");
    expect(texto).not.toContain("cerrado@example.test");
    expect(texto).toContain("4321");

    const comoOwner = await app.request(`${base}/${cerrado.id}`, authedGet(ctx.staff.owner.token));
    const visto = ((await comoOwner.json()) as { order: { customerPhone: string; customerEmail: string | null } }).order;
    expect(visto.customerPhone).toBe("9997654321");
    expect(visto.customerEmail).toBe("cerrado@example.test");
  });

  it("listado de clientes: staff ve el telefono enmascarado; owner completo", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/admin/customers`;
    const staff = (await (await app.request(url, authedGet(ctx.staff.staffSucursalA.token))).json()) as { customers: Array<{ phone: string }> };
    expect(JSON.stringify(staff)).not.toContain("9991112222");
    expect(staff.customers[0]?.phone.endsWith("2222")).toBe(true);
    const owner = (await (await app.request(url, authedGet(ctx.staff.owner.token))).json()) as { customers: Array<{ phone: string }> };
    expect(owner.customers[0]?.phone).toBe("9991112222");
  });
});
