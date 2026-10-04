// R-15: historial del dia del repartidor (entregados hoy en la zona de la sucursal) y efectivo a rendir. Afirma el EFECTO: que
// solo cuenta lo entregado HOY por ESTE repartidor, que el efectivo solo suma pedidos con metodo registrado y que nadie mas entra.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.ts";
import { totalizarEntregas } from "../src/routes/verticals/restaurantes/repartidor-historial.ts";
import { authedGet, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";

afterEach(() => vi.useRealTimers());
// 2026-10-03 18:00Z = 12:00 en Mexico (UTC-6): hoy local = 2026-10-03.
function ahora(iso = "2026-10-03T18:00:00Z") {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

describe("totalizarEntregas (puro)", () => {
  it("suma en centavos enteros: efectivo, tarjeta y pedidos sin metodo aparte", () => {
    expect(
      totalizarEntregas([
        { total: 100.1, paymentMethod: "efectivo" },
        { total: 200.2, paymentMethod: "efectivo" },
        { total: 50, paymentMethod: "tarjeta" },
        { total: 30, paymentMethod: null },
      ]),
    ).toEqual({ pedidos: 4, totalCentavos: 38030, efectivoCentavos: 30030, efectivoPedidos: 2, tarjetaCentavos: 5000, sinMetodoPedidos: 1 });
  });
  it("vacio => ceros", () => {
    expect(totalizarEntregas([])).toEqual({ pedidos: 0, totalCentavos: 0, efectivoCentavos: 0, efectivoPedidos: 0, tarjetaCentavos: 0, sinMetodoPedidos: 0 });
  });
});

describe("GET .../repartidor/historial-dia", () => {
  it("solo cuenta lo entregado HOY (zona de la sucursal) por ESTE repartidor; el efectivo no incluye tarjeta ni pedidos sin metodo", async () => {
    ahora();
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const yo = ctx.staff.repartidor.id;
    const base = { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "entregado" as const };
    // Hoy 00:30 local (06:30Z) y 11:00 local: cuentan. 23:30 local de AYER (05:30Z de hoy): NO cuenta.
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...base, total: 150, paymentMethod: "efectivo", assignedRepartidorId: yo, deliveredAt: "2026-10-03T06:30:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...base, total: 90.5, paymentMethod: "tarjeta", assignedRepartidorId: yo, deliveredAt: "2026-10-03T17:00:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...base, total: 40, paymentMethod: null, assignedRepartidorId: yo, deliveredAt: "2026-10-03T16:00:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...base, total: 999, paymentMethod: "efectivo", assignedRepartidorId: yo, deliveredAt: "2026-10-03T05:30:00Z" }));
    // De otro repartidor y de otra organizacion: nunca entran.
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...base, total: 777, paymentMethod: "efectivo", assignedRepartidorId: ctx.staff.staffSucursalA.id, deliveredAt: "2026-10-03T17:00:00Z" }));
    ctx.restaurantesRepo.seedOrder(makeOrder({ ...base, organizationId: ctx.otherOrganizationId, propertyId: ctx.otherPropertyId, total: 555, paymentMethod: "efectivo", assignedRepartidorId: yo, deliveredAt: "2026-10-03T17:00:00Z" }));
    const res = await buildApp(ctx.deps).request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/historial-dia`, authedGet(ctx.staff.repartidor.token));
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ fecha: "2026-10-03", zonaHoraria: "America/Mexico_City" });
    expect(r.totales).toEqual({ pedidos: 3, totalCentavos: 28050, efectivoCentavos: 15000, efectivoPedidos: 1, tarjetaCentavos: 9050, sinMetodoPedidos: 1 });
    expect(r.entregas.map((e: { total: number }) => e.total)).toEqual([90.5, 40, 150]);
    expect(JSON.stringify(r)).not.toMatch(/phone|telefono|address|direccion/i);
  });

  it("sin entregas hoy: lista vacia y totales en cero (vacio honesto)", async () => {
    ahora();
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const r = await (await buildApp(ctx.deps).request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/historial-dia`, authedGet(ctx.staff.repartidor.token))).json();
    expect(r.entregas).toEqual([]);
    expect(r.totales.pedidos).toBe(0);
  });

  it("owner, admin, staff de piso y owner ajeno -> 403; sin sesion -> 401", async () => {
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const url = `/v1/restaurantes/${ctx.propertyIdA}/repartidor/historial-dia`;
    for (const t of [ctx.staff.owner.token, ctx.staff.admin.token, ctx.staff.staffSucursalA.token, ctx.staff.otroOrgOwner.token]) {
      expect((await app.request(url, authedGet(t))).status).toBe(403);
    }
    expect((await app.request(url)).status).toBe(401);
  });

  it("marcar un pedido entregado fija deliveredAt (el historial del dia lo ve al instante)", async () => {
    ahora();
    const ctx = await buildRestaurantesKpiTestContext(buildApp);
    const o = makeOrder({ organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, status: "en_camino", total: 120, paymentMethod: "efectivo", assignedRepartidorId: ctx.staff.repartidor.id });
    ctx.restaurantesRepo.seedOrder(o);
    const app = buildApp(ctx.deps);
    const patch = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders/${o.id}/status`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ctx.staff.repartidor.token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "entregado" }),
    });
    expect(patch.status).toBe(200);
    const r = await (await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/historial-dia`, authedGet(ctx.staff.repartidor.token))).json();
    expect(r.totales).toMatchObject({ pedidos: 1, efectivoCentavos: 12000 });
  });
});
