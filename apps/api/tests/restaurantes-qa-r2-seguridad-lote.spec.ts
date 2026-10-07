// QA restaurantes R2, lote seguridad (R2-seguridad-03 y 05): contrato HTTP de la separacion de funciones en compensaciones y del pedido
// falso ligado al cliente. La semantica real de RLS/rol/sucursal la prueba scripts/verify-restaurantes-qa-seguridad-r2 contra Postgres real.
import { describe, expect, it } from "vitest";
import { InMemoryAutopilotoRepository } from "@atiende/domain-restaurantes";
import type { PedidoMemoria } from "@atiende/domain-restaurantes";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

async function mundo() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const auto = new InMemoryAutopilotoRepository();
  const app = buildApp({ ...ctx.deps, autopilotoRepo: () => auto });
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/autopiloto`;
  const o = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "completado", total: 200, customerName: "Deb", customerPhone: "9995550101", source: "whatsapp" });
  ctx.restaurantesRepo.seedOrder(o);
  const mem: PedidoMemoria = {
    id: o.id, organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "completado", total: 200, clienteNombre: "Deb", telefono: "9995550101", canal: "domicilio", numero: 12,
    renglones: [{ nombre: "Tacos", cantidad: 2 }],
  };
  auto.pedidos.set(o.id, mem);
  const q = await auto.crearSolicitud(ctx.organizationId, ctx.propertyIdA, "compensacion", o.id, { subtipo: "faltante" });
  return { ctx, auto, app, base, solicitudId: q.solicitudId! };
}

describe("R2-seguridad-03: reponer producto y descuento son decisiones de owner/admin", () => {
  it("el staff no ve esas dos decisiones en la lista; el owner y el admin si", async () => {
    const { ctx, app, base } = await mundo();
    const lista = async (token: string) => ((await (await app.request(`${base}/solicitudes`, authedGet(token))).json()) as { solicitudes: { tipo: string; decisionesPosibles: string[] }[] }).solicitudes.find((s) => s.tipo === "compensacion")!.decisionesPosibles;
    expect(await lista(ctx.staff.staffSucursalA.token)).toEqual(["sin_compensacion"]);
    expect(await lista(ctx.staff.owner.token)).toEqual(["sin_compensacion", "reponer_producto", "descuento_proximo"]);
    expect(await lista(ctx.staff.admin.token)).toEqual(["sin_compensacion", "reponer_producto", "descuento_proximo"]);
  });

  it("el staff recibe 403 al reponer o descontar y la solicitud sigue pendiente (sin pedido de $0 ni codigo)", async () => {
    const { ctx, auto, app, base, solicitudId } = await mundo();
    const url = `${base}/solicitudes/${solicitudId}/resolver`;
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { decision: "reponer_producto", indices: [0] }))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.staffSucursalA.token, { decision: "descuento_proximo", valor: 10 }))).status).toBe(403);
    const pendientes = await auto.listarSolicitudes(ctx.organizationId, { propertyIds: null, estado: "pendiente", limite: 10 });
    expect(pendientes.valor.map((s) => s.id)).toContain(solicitudId);
  });

  it("el staff si cierra la queja sin compensacion; el owner si repone", async () => {
    const t = await mundo();
    const url = `${t.base}/solicitudes/${t.solicitudId}/resolver`;
    expect((await t.app.request(url, authedJson(t.ctx.staff.staffSucursalA.token, { decision: "sin_compensacion" }))).status).toBe(200);
    const u = await mundo();
    const res = await u.app.request(`${u.base}/solicitudes/${u.solicitudId}/resolver`, authedJson(u.ctx.staff.owner.token, { decision: "reponer_producto", indices: [0] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reposicionOrderId: string | null }).reposicionOrderId).not.toBeNull();
  });
});

describe("R2-seguridad-05: el pedido falso debe ser del cliente de la URL", () => {
  it("un pedido de otro cliente de la misma organizacion responde 404 y no se marca", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ana = await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
    const beto = await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9993334444", "Beto Ruiz");
    const pedidoDeBeto = await ctx.restaurantesRepo.createOrderIdempotent(
      { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, customerId: beto.id, customerName: "Beto", customerPhone: "9993334444", customerAddress: null, customerEmail: null, branch: "A", total: 50, items: [], source: "whatsapp", notes: null, paymentMethod: "efectivo", callTranscript: null, callRecordingUrl: null },
      "b".repeat(64),
      null,
    );
    const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/customers`;
    const res = await app.request(`${base}/${ana.id}/orders/${pedidoDeBeto.id}/falso`, authedJson(ctx.staff.owner.token, { falso: true }, "POST"));
    expect(res.status).toBe(404);
    expect((await ctx.restaurantesRepo.getCustomerFicha(ctx.organizationId, beto.id))?.reliability.pedidosFalsos).toBe(0);
    expect((await app.request(`${base}/${beto.id}/orders/${pedidoDeBeto.id}/falso`, authedJson(ctx.staff.owner.token, { falso: true }, "POST"))).status).toBe(200);
  });
});
