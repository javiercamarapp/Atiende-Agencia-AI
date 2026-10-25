// Cajero vs encargado SIN rol nuevo: bandera `perfil_operativo` de la membresia (migracion 090). El cajero (staff marcado) captura, acepta y
// prepara pero NO despacha (en_camino / asignar repartidor) ni cancela; el encargado (staff sin marcar), el admin y el dueño si.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

async function escenario(marcarCajero: boolean) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const pedido = (status: "pending" | "preparando" = "preparando") => {
    const o = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status });
    ctx.restaurantesRepo.seedOrder(o);
    return o;
  };
  if (marcarCajero) {
    const r = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.staffSucursalA.id}/perfil-operativo`, authedJson(ctx.staff.owner.token, { perfil: "cajero" }, "PUT"));
    expect(r.status).toBe(200);
  }
  const estado = (o: { id: string }, token: string, body: unknown) =>
    app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${o.id}/status`, authedJson(token, body, "PATCH"));
  return { ctx, app, pedido, estado };
}

describe("cajero (staff marcado)", () => {
  it("acepta y prepara (200) pero no pone en camino ni cancela (403)", async () => {
    const { ctx, pedido, estado } = await escenario(true);
    const tk = ctx.staff.staffSucursalA.token;
    expect((await estado(pedido("pending"), tk, { status: "preparando" })).status).toBe(200);
    const enCamino = await estado(pedido(), tk, { status: "en_camino" });
    expect(enCamino.status).toBe(403);
    expect(await enCamino.text()).toContain("cajero");
    expect((await estado(pedido(), tk, { status: "cancelado", motivo: "cliente_desistio" })).status).toBe(403);
  });

  it("tampoco marca entregado ni completado (cerrar la entrega es despachar)", async () => {
    const { ctx, pedido, estado } = await escenario(true);
    const tk = ctx.staff.staffSucursalA.token;
    expect((await estado(pedido(), tk, { status: "entregado" })).status).toBe(403);
    expect((await estado(pedido(), tk, { status: "completado" })).status).toBe(403);
  });

  it("otras vias: el cajero (staff) no entra a las rutas del repartidor ni cambia estados por la ruta de repartidor", async () => {
    const { ctx, app, pedido } = await escenario(true);
    const o = pedido();
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${o.id}/status`, authedJson(ctx.staff.staffSucursalA.token, { status: "entregado" }, "PATCH"));
    expect(res.status).toBe(403);
  });

  it("no puede asignar repartidor", async () => {
    const { ctx, app, pedido } = await escenario(true);
    const o = pedido();
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${o.id}/assign-repartidor`, authedJson(ctx.staff.staffSucursalA.token, { repartidorId: ctx.staff.repartidor.id }, "PATCH"));
    expect(res.status).toBe(403);
  });
});

describe("encargado (staff sin marcar), admin y dueño", () => {
  it("compatibilidad: sin marcar a nadie, el staff despacha y cancela como hoy", async () => {
    const { ctx, pedido, estado } = await escenario(false);
    expect((await estado(pedido(), ctx.staff.staffSucursalA.token, { status: "en_camino" })).status).toBe(200);
    expect((await estado(pedido(), ctx.staff.staffSucursalA.token, { status: "cancelado", motivo: "cliente_desistio" })).status).toBe(200);
  });

  it("aunque haya un cajero marcado, owner y admin siguen despachando y cancelando", async () => {
    const { ctx, pedido, estado } = await escenario(true);
    expect((await estado(pedido(), ctx.staff.owner.token, { status: "en_camino" })).status).toBe(200);
    expect((await estado(pedido(), ctx.staff.admin.token, { status: "cancelado", motivo: "cliente_desistio" })).status).toBe(200);
  });

  it("volver a marcar encargado (o null) le devuelve el permiso", async () => {
    const { ctx, app, pedido, estado } = await escenario(true);
    const r = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${ctx.staff.staffSucursalA.id}/perfil-operativo`, authedJson(ctx.staff.owner.token, { perfil: null }, "PUT"));
    expect(r.status).toBe(200);
    expect((await estado(pedido(), ctx.staff.staffSucursalA.token, { status: "en_camino" })).status).toBe(200);
  });
});

describe("PUT admin/staff/miembros/:userId/perfil-operativo", () => {
  const url = (ctx: { propertyIdA: string }, id: string) => `/v1/restaurantes/${ctx.propertyIdA}/admin/staff/miembros/${id}/perfil-operativo`;

  it("solo owner/admin; staff y repartidor 403; valor invalido 400; objetivo que no es staff 409; se audita", async () => {
    const { ctx, app } = await escenario(false);
    const id = ctx.staff.staffSucursalA.id;
    expect((await app.request(url(ctx, id), authedJson(ctx.staff.staffSucursalA.token, { perfil: "cajero" }, "PUT"))).status).toBe(403);
    expect((await app.request(url(ctx, id), authedJson(ctx.staff.repartidor.token, { perfil: "cajero" }, "PUT"))).status).toBe(403);
    expect((await app.request(url(ctx, id), authedJson(ctx.staff.owner.token, { perfil: "gerente" }, "PUT"))).status).toBe(400);
    expect((await app.request(url(ctx, ctx.staff.admin.id), authedJson(ctx.staff.owner.token, { perfil: "cajero" }, "PUT"))).status).toBe(409);
    expect((await app.request(url(ctx, id), authedJson(ctx.staff.admin.token, { perfil: "cajero" }, "PUT"))).status).toBe(200);
    expect(ctx.restaurantesRepo.auditLog.some((r) => r.action === "staff.perfil_operativo_actualizado" && r.entityId === id && r.despues === "cajero")).toBe(true);
  });

  it("admin ACOTADO (solo algunas sucursales) no cambia perfiles: 403 y el perfil no cambia; admin general y dueño si", async () => {
    const { ctx, app } = await escenario(false);
    const id = ctx.staff.staffSucursalA.id;
    expect((await app.request(url(ctx, id), authedJson(ctx.staff.adminSucursalA.token, { perfil: "cajero" }, "PUT"))).status).toBe(403);
    expect(ctx.restaurantesRepo.perfilesOperativos.get(`${ctx.organizationId}:${id}`)).toBeUndefined();
    expect((await app.request(url(ctx, id), authedJson(ctx.staff.admin.token, { perfil: "cajero" }, "PUT"))).status).toBe(200);
  });

  it("la bitacora guarda el perfil previo (antes) y el nuevo (despues)", async () => {
    const { ctx, app } = await escenario(false);
    const id = ctx.staff.staffSucursalA.id;
    await app.request(url(ctx, id), authedJson(ctx.staff.owner.token, { perfil: "cajero" }, "PUT"));
    await app.request(url(ctx, id), authedJson(ctx.staff.owner.token, { perfil: null }, "PUT"));
    const filas = ctx.restaurantesRepo.auditLog.filter((r) => r.action === "staff.perfil_operativo_actualizado" && r.entityId === id);
    expect(filas.map((r) => [r.antes, r.despues])).toEqual([["encargado", "cajero"], ["cajero", "encargado"]]);
  });

  it("si la bitacora falla NO se traga el error: la ruta responde error (no 200)", async () => {
    const { ctx, app } = await escenario(false);
    ctx.restaurantesRepo.fallarAuditoriaObligatoria = true;
    const res = await app.request(url(ctx, ctx.staff.staffSucursalA.id), authedJson(ctx.staff.owner.token, { perfil: "cajero" }, "PUT"));
    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
