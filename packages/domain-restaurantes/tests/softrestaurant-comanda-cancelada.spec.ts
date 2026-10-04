// Un pedido cancelado antes de llegar al POS no debe mandar su comanda a cocina cuando el POS vuelve (reintento del despachador).
import { describe, expect, it, vi } from "vitest";
import { createOrder } from "../src/orders.ts";
import { MapaProductoCodigo } from "../src/softrestaurant/catalog-map.ts";
import { FakeSoftRestaurantAdapter } from "../src/softrestaurant/fake-adapter.ts";
import { InMemoryComandaOutboxStore } from "../src/softrestaurant/outbox-memory-store.ts";
import { NOTA_COMANDA_CORTADA_POR_CANCELACION, cortarComandaDePedidoCancelado, crearResolverSucursalPos, drenarComandas, encolarComandaParaPedido } from "../src/softrestaurant/outbox-service.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const T0 = new Date("2026-09-30T18:00:00.000Z");
const ACTOR = "11111111-1111-4111-8111-111111111111";

async function preparar() {
  const fx = buildRestaurantFixture();
  const mk = (tel: string) =>
    createOrder(fx.repo, { organizationId: fx.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: tel, customerAddress: "Calle 80 #30 x 5 y 7, Centro", paymentMethod: "efectivo", items: [{ productId: fx.products.cocaCola, requestedQuantity: 2 }], source: "web" });
  const [cancelado, vivo] = [await mk("9990001111"), await mk("9990002222")];
  let reloj = T0;
  const ahora = () => reloj;
  const store = new InMemoryComandaOutboxStore({ ahora });
  store.ponerModo(fx.organizationId, "activo");
  const port = new FakeSoftRestaurantAdapter({ ahora });
  const mapa = new MapaProductoCodigo([{ productId: fx.products.cocaCola, codigo: "FAKE-003" }]);
  const deps = { store, port, resolverCodigos: mapa, resolverSucursal: crearResolverSucursalPos({ [fx.propertyId]: "T2" }), ahora, politica: { maxIntentos: 3, baseMs: 30_000, maxMs: 900_000, leaseMs: 120_000 } };
  return { fx, cancelado, vivo, store, port, deps, avanzar: (ms: number) => (reloj = new Date(reloj.getTime() + ms)), drenar: () => drenarComandas({ port, abrirUnidad: async (fn) => fn({ store }), resolverCodigos: mapa, politica: deps.politica, ahora }, 10) };
}

describe("cortarComandaDePedidoCancelado", () => {
  it("POS caido + pedido cancelado: la comanda pasa a capturada_manual con nota y NO llega al POS al volver; la de otro pedido si", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "timeout" }, 2);
    await encolarComandaParaPedido(t.deps, { order: t.cancelado });
    await encolarComandaParaPedido(t.deps, { order: t.vivo });
    expect(t.store.todas().map((f) => f.estado).sort()).toEqual(["fallida", "fallida"]);

    const r = await cortarComandaDePedidoCancelado(t.store, t.fx.organizationId, t.cancelado, ACTOR);
    expect(r.cortadas).toBe(1);
    const fila = t.store.todas().find((f) => f.orderId === t.cancelado.id)!;
    expect(fila).toMatchObject({ estado: "capturada_manual", capturadoPor: ACTOR, notaCaptura: NOTA_COMANDA_CORTADA_POR_CANCELACION });

    t.avanzar(30 * 60_000);
    const resumen = await t.drenar();
    expect(resumen.confirmadas).toBe(1);
    expect(t.port.comandas).toHaveLength(1);
    expect(t.store.todas().find((f) => f.orderId === t.vivo.id)?.estado).toBe("confirmada");
  });

  it("una comanda ya confirmada en el POS no se toca (ya esta en cocina)", async () => {
    const t = await preparar();
    await encolarComandaParaPedido(t.deps, { order: t.cancelado });
    expect(t.store.todas()[0]!.estado).toBe("confirmada");
    expect((await cortarComandaDePedidoCancelado(t.store, t.fx.organizationId, t.cancelado, ACTOR)).cortadas).toBe(0);
    expect(t.store.todas()[0]!.estado).toBe("confirmada");
  });

  it("de otra organizacion no corta nada; sin migracion (store no disponible) no hace nada; un error del store no lanza", async () => {
    const t = await preparar();
    t.port.inyectarFalla("crearComanda", { tipo: "timeout" });
    await encolarComandaParaPedido(t.deps, { order: t.cancelado });
    expect((await cortarComandaDePedidoCancelado(t.store, "00000000-0000-4000-8000-000000000000", t.cancelado, ACTOR)).cortadas).toBe(0);
    expect(t.store.todas()[0]!.estado).toBe("fallida");

    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(t.store, "listar").mockRejectedValueOnce(new Error("boom"));
    await expect(cortarComandaDePedidoCancelado(t.store, t.fx.organizationId, t.cancelado, ACTOR)).resolves.toEqual({ cortadas: 0 });
    t.store.disponible = false;
    expect((await cortarComandaDePedidoCancelado(t.store, t.fx.organizationId, t.cancelado, ACTOR)).cortadas).toBe(0);
  });
});
