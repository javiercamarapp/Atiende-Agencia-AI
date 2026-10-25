// Reintento TARDIO de un pedido ya creado (revision independiente): la dedupe del servidor (create_order_idempotent) es una ventana de 5 min y SOLO sobre pedidos en
// pending/programado. Estos tests fijan lo que pasa fuera de esa ventana y que capa lo cubre:
//   * createOrder suelto (sin llave de idempotencia): reintento dentro de 5 min en pending = el mismo pedido; despues de 5 min o con el pedido ya cambiado de estado = pedido NUEVO.
//     Es a proposito (un cliente puede querer otro igual); NO es la defensa contra el reintento de la llamada.
//   * La defensa del reintento de la LLAMADA es el estado del flujo (`creado` + orderId + misma huella): crear_pedido devuelve el pedido existente (ya_registrado) sin importar
//     la ventana de 5 min ni el estado del pedido, mientras el flujo viva (30 min); y cotizar el mismo carrito tampoco abre otro.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeAgentTool } from "../src/agent-tools/registry.ts";
import { resetOrderFlowWarningForTests } from "../src/agent-tools/order-flow.ts";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const T0 = new Date("2026-10-06T13:00:00-06:00");
const minutos = (n: number) => new Date(T0.getTime() + n * 60_000);
beforeEach(() => {
  resetOrderFlowWarningForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function mundo() {
  const f = buildRestaurantFixture();
  f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
  void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
  const pedir = () =>
    createOrder(f.repo, {
      organizationId: f.organizationId, branchSlug: "fco-montejo", customerName: "Ana", customerPhone: "9991234567", customerAddress: "Calle 50 #200, Col. Centro",
      items: [{ productId: f.products.cocaCola, requestedQuantity: 2 }], source: "voice", paymentMethod: "efectivo",
    });
  return { f, pedir };
}

describe("dedupe del servidor (create_order_idempotent): 5 min y solo en pending", () => {
  it("reintento dentro de 5 min con el pedido aun en pending: devuelve el MISMO pedido", async () => {
    const { f, pedir } = mundo();
    const a = await pedir();
    vi.setSystemTime(minutos(4));
    const b = await pedir();
    expect(b.id).toBe(a.id);
    expect((f.repo as unknown as { orders: unknown[] }).orders).toHaveLength(1);
  });
  it("LIMITE DOCUMENTADO: despues de 5 min el mismo pedido nace de nuevo en el servidor (lo cubre el flujo, ver abajo)", async () => {
    const { f, pedir } = mundo();
    const a = await pedir();
    vi.setSystemTime(minutos(6));
    const b = await pedir();
    expect(b.id).not.toBe(a.id);
    expect((f.repo as unknown as { orders: unknown[] }).orders).toHaveLength(2);
  });
  it("LIMITE DOCUMENTADO: si cocina ya cambio el estado del pedido (preparando) un reintento a los 2 min tambien crea otro en el servidor", async () => {
    const { f, pedir } = mundo();
    const a = await pedir();
    await f.repo.updateOrderStatus(f.organizationId, a.id, "pending", "preparando");
    vi.setSystemTime(minutos(2));
    const b = await pedir();
    expect(b.id).not.toBe(a.id);
  });
});

describe.each(["voz", "whatsapp"] as const)("%s: el reintento tardio de crear_pedido en la misma llamada o chat NO duplica", (channel) => {
  async function conPedido() {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { horario: [{ dias: [0, 1, 2, 3, 4, 5, 6], abre: "12:00", cierra: "01:00" }] });
    void f.repo.upsertBranchZonaHoraria(f.propertyId, "America/Merida");
    let turn = 1;
    const ctx = () => ({ organizationId: f.organizationId, channel, phone: "9991234567", flow: { key: `tardio:${channel}`, turn: String(turn), now: () => Date.now() } });
    const items = [{ product_id: f.products.cocaCola, product_name: "Coca-Cola", requested_quantity: 2 }];
    const base = { branch_slug: "fco-montejo", canal: "recoger" };
    await invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, items });
    turn += 1;
    await invokeAgentTool(f.repo, ctx(), "confirmar_resumen", {});
    const crear = () => invokeAgentTool(f.repo, ctx(), "crear_pedido", { ...base, items, customer_name: "Ana", payment_method: "efectivo" });
    const primero = await crear();
    const pedidos = () => (f.repo as unknown as { orders: Array<{ id: string }> }).orders;
    return { f, crear, primero, pedidos, siguienteTurno: () => void (turn += 1), cotizar: () => invokeAgentTool(f.repo, ctx(), "cotizar_pedido", { ...base, items }) };
  }

  it("reintento a los 20 min (fuera de los 5 min del servidor) con el pedido ya en preparacion: no nace otro", async () => {
    const { f, crear, primero, pedidos, siguienteTurno } = await conPedido();
    await f.repo.updateOrderStatus(f.organizationId, primero.orderId!, "pending", "preparando");
    vi.setSystemTime(minutos(20));
    siguienteTurno();
    if (channel === "voz") await expect(crear()).resolves.toMatchObject({ orderId: primero.orderId, yaRegistrado: true });
    else await expect(crear()).rejects.toMatchObject({ code: "pedido_ya_creado" });
    expect(pedidos()).toHaveLength(1);
  });

  it("cotizar el mismo carrito a los 20 min con el pedido ya en preparacion devuelve ya_registrado, no una cotizacion nueva", async () => {
    const { f, primero, pedidos, siguienteTurno, cotizar } = await conPedido();
    await f.repo.updateOrderStatus(f.organizationId, primero.orderId!, "pending", "preparando");
    vi.setSystemTime(minutos(20));
    siguienteTurno();
    const otra = await cotizar();
    expect(otra.result).toMatchObject({ ya_registrado: true, pedido_id: primero.orderId });
    expect(pedidos()).toHaveLength(1);
  });
});
