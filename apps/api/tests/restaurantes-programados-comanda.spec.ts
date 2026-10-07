// R-29 -- HTTP end-to-end: al promover un pedido programado a cocina (auto-promocion al consultar el panel,
// endpoint interno y adelanto manual) se encola su comanda al POS (SoftRestaurant) en la sesion de sistema,
// despues del commit, de forma idempotente y sin romper nada si la bandera esta apagada o el store falla.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { FakeSoftRestaurantAdapter, InMemoryComandaOutboxStore, type SoftRestaurantPort } from "@atiende/domain-restaurantes/softrestaurant";
import { authedGet, authedJson, buildRestaurantesKpiTestContext, makeOrder } from "./restaurantes-admin-kpis-fixtures.ts";
import { TEST_ENV } from "./fixtures.ts";

const enMin = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

async function contexto(modo: "apagado" | "sombra" | "activo" = "sombra", opciones: { disponible?: boolean } = {}) {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const store = new InMemoryComandaOutboxStore({ disponible: opciones.disponible ?? true });
  store.ponerModo(ctx.organizationId, modo);
  const fake = new FakeSoftRestaurantAdapter();
  const deps: AppDeps = { ...ctx.deps, softRestaurantStore: () => store, softRestaurantPort: new Proxy(fake, { get: (t, p, r) => (p === "esReal" ? true : Reflect.get(t, p, r)) }) as unknown as SoftRestaurantPort };
  const programado = (propertyId: string, minutos: number, extra: Record<string, unknown> = {}) => {
    const o = makeOrder({ organizationId: ctx.organizationId, propertyId, status: "programado", total: 100, programadoPara: enMin(minutos), promovidoAt: null, ...extra });
    ctx.restaurantesRepo.seedOrder(o);
    return o;
  };
  return { ctx, store, fake, programado, app: buildApp(deps) };
}

describe("promocion al consultar el panel -> comanda al POS", () => {
  it("encola una comanda por cada pedido promovido (con la hora programada) y ninguna para el lejano ni el cancelado; sin llamar al POS", async () => {
    const { ctx, store, fake, programado, app } = await contexto("sombra");
    const proximo = programado(ctx.propertyIdA, 10);
    programado(ctx.propertyIdA, 300);
    programado(ctx.propertyIdA, 5, { status: "cancelado" });
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const filas = store.todas();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ orderId: proximo.id, organizationId: ctx.organizationId, estado: "pendiente", payload: { horaCompromiso: proximo.programadoPara } });
    expect(fake.llamadasCrear).toHaveLength(0);
  });

  it("idempotente: consultar de nuevo (o desde el listado de pedidos) no duplica la comanda", async () => {
    const { ctx, store, programado, app } = await contexto("activo");
    programado(ctx.propertyIdA, 10);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders?status=pending`, authedGet(ctx.staff.owner.token));
    expect(store.todas()).toHaveLength(1);
  });

  it("bandera APAGADA: la promocion funciona igual y no se encola nada", async () => {
    const { ctx, store, programado, app } = await contexto("apagado");
    const p = programado(ctx.propertyIdA, 10);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    expect(((await res.json()) as { promovidos: string[] }).promovidos).toEqual([p.id]);
    expect(store.todas()).toHaveLength(0);
  });

  it("base sin la migracion 024 (store no disponible): 200, promovido y sin comanda (nunca un 500)", async () => {
    const { ctx, store, programado, app } = await contexto("activo", { disponible: false });
    const p = programado(ctx.propertyIdA, 10);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { promovidos: string[] }).promovidos).toEqual([p.id]);
    expect(store.todas()).toHaveLength(0);
  });

  it("si el store falla al encolar, la respuesta del panel sigue siendo 200 y el pedido queda promovido", async () => {
    const { ctx, store, programado, app } = await contexto("sombra");
    store.encolar = async () => {
      throw new Error("falla simulada");
    };
    const p = programado(ctx.propertyIdA, 10);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    expect((await ctx.restaurantesRepo.findOrderById(ctx.organizationId, p.id))?.status).toBe("pending");
  });

  it("aislamiento: un pedido de otra organizacion jamas se encola desde el panel de esta", async () => {
    const { ctx, store, programado, app } = await contexto("sombra");
    programado(ctx.propertyIdB, 10);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/scheduled-orders?branchId=${ctx.propertyIdA}`, authedGet(ctx.staff.staffSucursalA.token));
    expect(store.todas().every((f) => f.propertyId === ctx.propertyIdA)).toBe(true);
  });
});

describe("adelanto manual programado -> pendiente", () => {
  it("encola la comanda; cancelar un programado NO encola nada", async () => {
    const { ctx, store, programado, app } = await contexto("sombra");
    const a = programado(ctx.propertyIdA, 600);
    const b = programado(ctx.propertyIdA, 700);
    await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${b.id}/status`, authedJson(ctx.staff.owner.token, { status: "cancelado", motivo: "otro" }, "PATCH"));
    expect(store.todas()).toHaveLength(0);
    const res = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${a.id}/status`, authedJson(ctx.staff.owner.token, { status: "pending" }, "PATCH"));
    expect(res.status).toBe(200);
    expect(store.todas().map((f) => f.orderId)).toEqual([a.id]);
  });
});

describe("/internal/restaurantes/promover-programados -> comanda al POS", () => {
  it("promueve y encola; la segunda llamada no duplica; reporta el resumen de comandas", async () => {
    const { ctx, store, programado, app } = await contexto("sombra");
    const p = programado(ctx.propertyIdA, 10);
    const llamar = () => app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    const r1 = (await (await llamar()).json()) as { promoted: number; comandas: { intentados: number; encoladas: number } };
    expect(r1.promoted).toBe(1);
    expect(r1.comandas).toMatchObject({ intentados: 1, encoladas: 1 });
    const r2 = (await (await llamar()).json()) as { promoted: number; comandas: { intentados: number } };
    expect(r2.promoted).toBe(0);
    expect(r2.comandas.intentados).toBe(0);
    expect(store.todas().map((f) => f.orderId)).toEqual([p.id]);
  });

  it("un fallo del store no cambia el resultado de la promocion (200 ok:true) y se reporta en comandas.errores", async () => {
    const { ctx, store, programado, app } = await contexto("sombra");
    store.encolar = async () => {
      throw new Error("falla simulada");
    };
    programado(ctx.propertyIdA, 10);
    const res = await app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; promoted: number; comandas: { errores: number } };
    expect(body).toMatchObject({ ok: true, promoted: 1 });
    expect(body.comandas.errores).toBe(1);
  });
});
