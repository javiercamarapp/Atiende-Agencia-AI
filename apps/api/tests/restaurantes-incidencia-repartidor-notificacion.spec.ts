// R-16 -- aviso in-app cuando un repartidor reporta una incidencia (status `problema`): productor compartido,
// uno por pedido, sin PII ni texto de la nota; un fallo de la base (sin migrar) nunca revierte el cambio de estado.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

async function construir(opts: { alEmitir?: () => number } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const { deps, emisiones } = conEmisiones(ctx.deps, opts.alEmitir ? { alEmitir: opts.alEmitir } : {});
  const order = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", total: 100 });
  ctx.restaurantesRepo.seedOrder(order);
  await ctx.restaurantesRepo.assignRepartidorToOrder(ctx.organizationId, order.id, ctx.staff.repartidor.id, null);
  const app = buildApp(deps);
  const patch = (body: unknown) => app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${order.id}/status`, authedJson(ctx.staff.repartidor.token, body, "PATCH"));
  return { ctx, order, emisiones, patch };
}

describe("incidencia del repartidor", () => {
  it("reportar `problema` emite UNA notificacion de atencion con enlace a Pedidos y sin la nota del repartidor", async () => {
    const t = await construir();
    const res = await t.patch({ status: "problema", incidentNote: "El cliente Juan Perez no contesta, tel 9991234567." });
    expect(res.status).toBe(200);
    expect(t.emisiones).toHaveLength(1);
    expect(t.emisiones[0]).toMatchObject({
      evento: "restaurantes.pedido.incidencia_repartidor",
      organizationId: t.ctx.organizationId,
      propertyId: t.ctx.propertyIdA,
      severidad: "atencion",
      categoria: "operacion",
      enlace: "/restaurantes/{orgSlug}/pedidos",
      dedupeKey: `restaurantes.pedido.incidencia_repartidor:${t.order.id}`,
      roles: ["staff"],
    });
    expect(`${t.emisiones[0]!.titulo} ${t.emisiones[0]!.cuerpo}`).not.toMatch(/Juan|9991234567|\d{7,}|@/);
  });

  it("otros cambios de estado (entregado) no emiten", async () => {
    const t = await construir();
    const res = await t.patch({ status: "entregado" });
    expect(res.status).toBe(200);
    expect(t.emisiones).toHaveLength(0);
  });

  it("un `problema` rechazado (sin nota -> 409) no emite", async () => {
    const t = await construir();
    const res = await t.patch({ status: "problema" });
    expect(res.status).toBe(409);
    expect(t.emisiones).toHaveLength(0);
  });

  it("si la base no tiene el productor (42883) el cambio de estado igual se confirma", async () => {
    const t = await construir({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const res = await t.patch({ status: "problema", incidentNote: "Dirección incorrecta." });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { order: { status: string } }).order.status).toBe("problema");
  });
});
