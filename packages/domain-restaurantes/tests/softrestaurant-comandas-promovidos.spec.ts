import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { MapaProductoCodigo } from "../src/softrestaurant/catalog-map.ts";
import { FakeSoftRestaurantAdapter } from "../src/softrestaurant/fake-adapter.ts";
import { InMemoryComandaOutboxStore } from "../src/softrestaurant/outbox-memory-store.ts";
import {
  crearResolverSucursalPos,
  drenarComandas,
  encolarComandasDePromovidos,
  type DepsComandaPos,
} from "../src/softrestaurant/outbox-service.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const T0 = new Date("2026-09-30T18:00:00.000Z");

async function preparar(opciones: { codigos?: boolean; sucursal?: boolean; modo?: "apagado" | "sombra" | "activo" } = {}) {
  const fx = buildRestaurantFixture();
  const order = await createOrder(fx.repo, {
    organizationId: fx.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Deb",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30 x 5 y 7, Centro",
    paymentMethod: "efectivo",
    items: [{ productId: fx.products.cocaCola, requestedQuantity: 2 }],
    source: "web",
  });
  let reloj = T0;
  const ahora = () => reloj;
  const store = new InMemoryComandaOutboxStore({ ahora });
  store.ponerModo(fx.organizationId, opciones.modo ?? "activo");
  const port = new FakeSoftRestaurantAdapter({ ahora });
  const mapa = new MapaProductoCodigo(opciones.codigos === false ? [] : [{ productId: fx.products.cocaCola, codigo: "FAKE-003" }]);
  const alertar = vi.fn(async () => undefined);
  const deps: DepsComandaPos = {
    store,
    port,
    resolverCodigos: mapa,
    resolverSucursal: crearResolverSucursalPos(opciones.sucursal === false ? {} : { [fx.propertyId]: "T2" }),
    ahora,
    alertar,
    politica: { maxIntentos: 3, baseMs: 30_000, maxMs: 900_000, leaseMs: 120_000 },
  };
  return {
    fx,
    order,
    store,
    port,
    deps,
    alertar,
    avanzar: (ms: number) => {
      reloj = new Date(reloj.getTime() + ms);
    },
    drenar: (limite = 10) =>
      drenarComandas({ port, abrirUnidad: async (fn) => fn({ store, alertar }), resolverCodigos: mapa, politica: deps.politica, ahora }, limite),
  };
}


// R-29: al promover un pedido programado a cocina se encola su comanda al POS (antes se omitia).
describe("encolarComandasDePromovidos", () => {
  const HORA = "2026-10-03T20:00:00.000Z";

  it("encola UNA comanda por pedido promovido, con la hora programada como horaCompromiso y SIN enviar al POS", async () => {
    const t = await preparar({ modo: "activo" });
    const promovido = { ...t.order, status: "pending" as const, programadoPara: HORA };
    const r = await encolarComandasDePromovidos(t.deps, [promovido]);
    expect(r).toEqual({ intentados: 1, encoladas: 1, omitidas: 0, errores: 0 });
    const filas = t.store.todas();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ orderId: t.order.id, estado: "pendiente", payload: { horaCompromiso: HORA } });
    // Aun en modo activo, la promocion nunca bloquea en el POS: lo envia el despachador.
    expect(t.port.llamadasCrear).toHaveLength(0);
  });

  it("idempotente: promover/reencolar el mismo pedido dos veces deja una sola fila", async () => {
    const t = await preparar({ modo: "sombra" });
    const promovido = { ...t.order, status: "pending" as const, programadoPara: HORA };
    await encolarComandasDePromovidos(t.deps, [promovido]);
    const segunda = await encolarComandasDePromovidos(t.deps, [promovido]);
    expect(segunda.encoladas).toBe(1);
    expect(t.store.todas()).toHaveLength(1);
  });

  it("la fila encolada se drena despues con el despachador y llega al POS con su folio", async () => {
    const t = await preparar({ modo: "activo" });
    await encolarComandasDePromovidos(t.deps, [{ ...t.order, status: "pending", programadoPara: HORA }]);
    const resumen = await t.drenar();
    expect(resumen.confirmadas).toBe(1);
    expect(t.port.llamadasCrear).toHaveLength(1);
  });

  it("bandera APAGADA o base sin migracion 024: no encola nada y cuenta omitida (comportamiento anterior intacto)", async () => {
    const apagada = await preparar({ modo: "apagado" });
    expect(await encolarComandasDePromovidos(apagada.deps, [{ ...apagada.order, status: "pending", programadoPara: HORA }])).toEqual({ intentados: 1, encoladas: 0, omitidas: 1, errores: 0 });
    expect(apagada.store.todas()).toHaveLength(0);

    const sinMigrar = await preparar({ modo: "activo" });
    sinMigrar.store.disponible = false;
    expect((await encolarComandasDePromovidos(sinMigrar.deps, [{ ...sinMigrar.order, status: "pending", programadoPara: HORA }])).omitidas).toBe(1);
  });

  it("un pedido que no esta en pending (cancelado, programado) nunca se encola", async () => {
    const t = await preparar({ modo: "sombra" });
    const r = await encolarComandasDePromovidos(t.deps, [
      { ...t.order, status: "cancelado", programadoPara: HORA },
      { ...t.order, status: "programado", programadoPara: HORA },
    ]);
    expect(r.intentados).toBe(0);
    expect(t.store.todas()).toHaveLength(0);
  });

  it("un fallo del store NO lanza y se cuenta como error; los demas pedidos del lote siguen", async () => {
    const t = await preparar({ modo: "sombra" });
    const original = t.store.encolar.bind(t.store);
    let n = 0;
    t.store.encolar = async (e) => {
      n += 1;
      if (n === 1) throw new Error("falla simulada del store");
      return original(e);
    };
    const otro = { ...t.order, id: randomUUID(), status: "pending" as const, programadoPara: HORA };
    const r = await encolarComandasDePromovidos(t.deps, [{ ...t.order, status: "pending", programadoPara: HORA }, otro]);
    expect(r).toEqual({ intentados: 2, encoladas: 1, omitidas: 0, errores: 1 });
  });
});
