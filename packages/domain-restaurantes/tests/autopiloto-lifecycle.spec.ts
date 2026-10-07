// Estado `por_aprobar`: transiciones de la maquina de estados y defensa contra el atajo manual.
import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, OrderStatusTransitionError, assertValidOrderStatusTransition, changeOrderStatus, isOrderStatus, nextValidStatuses } from "../src/order-lifecycle.ts";
import { estadoParaCliente } from "../src/pedido-reciente.ts";
import { ORDEN_ESTADO_ETIQUETAS } from "../src/exportar/formato.ts";
import { createOrder } from "../src/orders.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

describe("por_aprobar en la maquina de estados", () => {
  it("es un estado valido y solo avanza a pending, programado o cancelado", () => {
    expect(isOrderStatus("por_aprobar")).toBe(true);
    expect(ORDER_STATUSES).toContain("por_aprobar");
    expect([...nextValidStatuses("por_aprobar")].sort()).toEqual(["cancelado", "pending", "programado"]);
    for (const hacia of ["preparando", "en_camino", "entregado", "completado", "problema"] as const) {
      expect(() => assertValidOrderStatusTransition("por_aprobar", hacia)).toThrow(OrderStatusTransitionError);
    }
  });

  it("ningun estado salta a por_aprobar por la maquina manual (solo lo retiene el servidor)", () => {
    for (const desde of ORDER_STATUSES) expect(nextValidStatuses(desde)).not.toContain("por_aprobar");
  });

  it("changeOrderStatus (cambio manual de estado) rechaza mover un pedido por_aprobar: se aprueba o rechaza con su solicitud", async () => {
    const fixture = buildRestaurantFixture();
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId, branchSlug: "fco-montejo", customerName: "Deb", customerPhone: "9990001111", customerAddress: "Calle 80 #30",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }], source: "web",
    });
    const retenido = (await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "pending", "por_aprobar"))!;
    await expect(changeOrderStatus(fixture.repo, fixture.organizationId, retenido, "pending")).rejects.toThrow(/Por aprobar/);
    await expect(changeOrderStatus(fixture.repo, fixture.organizationId, retenido, "cancelado")).rejects.toBeInstanceOf(OrderStatusTransitionError);
    expect((await fixture.repo.findOrderById(fixture.organizationId, order.id))!.status).toBe("por_aprobar");
  });

  it("el agente nunca dice que va en camino: por_aprobar se traduce a 'por_confirmar'", () => {
    expect(estadoParaCliente("por_aprobar")).toBe("por_confirmar");
  });

  it("las exportaciones rotulan el estado en espanol", () => {
    expect(ORDEN_ESTADO_ETIQUETAS.por_aprobar).toBe("Por aprobar");
  });
});
