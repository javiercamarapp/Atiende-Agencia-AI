// Fase 5 back-office CORE — máquina de estados real de un pedido (ver diseño
// §1.3). Cubre: transición válida persiste, transición inválida se rechaza SIN
// tocar el repositorio, y las transiciones terminales (cancelado/completado) nunca
// reabren.
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { assertValidOrderStatusTransition, changeOrderStatus, isOrderStatus, nextValidStatuses, OrderStatusTransitionError, ORDER_STATUSES } from "../src/order-lifecycle.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

describe("isOrderStatus / ORDER_STATUSES", () => {
  it("reconoce exactamente los 7 valores reales de orders.status (migrations/001) — nunca inventa uno nuevo", () => {
    expect(ORDER_STATUSES).toEqual(["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema"]);
    expect(isOrderStatus("pending")).toBe(true);
    expect(isOrderStatus("listo")).toBe(false); // status inventado, nunca válido
  });
});

describe("assertValidOrderStatusTransition", () => {
  it("permite el avance normal pending -> preparando -> en_camino -> entregado -> completado", () => {
    expect(() => assertValidOrderStatusTransition("pending", "preparando")).not.toThrow();
    expect(() => assertValidOrderStatusTransition("preparando", "en_camino")).not.toThrow();
    expect(() => assertValidOrderStatusTransition("en_camino", "entregado")).not.toThrow();
    expect(() => assertValidOrderStatusTransition("entregado", "completado")).not.toThrow();
  });

  it("rechaza un salto que se brinca la preparación (pending -> entregado)", () => {
    expect(() => assertValidOrderStatusTransition("pending", "entregado")).toThrow(OrderStatusTransitionError);
  });

  it("rechaza permanecer en el mismo estado", () => {
    expect(() => assertValidOrderStatusTransition("preparando", "preparando")).toThrow(/ya está en estado/);
  });

  it("cancelado y completado son terminales — ninguna transición sale de ahí", () => {
    expect(nextValidStatuses("cancelado")).toEqual([]);
    expect(nextValidStatuses("completado")).toEqual([]);
    expect(() => assertValidOrderStatusTransition("cancelado", "pending")).toThrow(OrderStatusTransitionError);
    expect(() => assertValidOrderStatusTransition("completado", "problema")).toThrow(OrderStatusTransitionError);
  });

  it("'problema' se recupera hacia preparando o cancelado, nunca queda varado", () => {
    expect(nextValidStatuses("problema")).toEqual(["preparando", "cancelado"]);
    expect(() => assertValidOrderStatusTransition("problema", "entregado")).toThrow(OrderStatusTransitionError);
  });

  it("cancelado disponible desde pending/preparando (antes de despachar) — una vez en camino ya no se cancela directo, solo se reporta 'problema'", () => {
    expect(() => assertValidOrderStatusTransition("pending", "cancelado")).not.toThrow();
    expect(() => assertValidOrderStatusTransition("preparando", "cancelado")).not.toThrow();
    expect(() => assertValidOrderStatusTransition("en_camino", "cancelado")).toThrow(OrderStatusTransitionError);
    expect(() => assertValidOrderStatusTransition("en_camino", "problema")).not.toThrow();
  });
});

describe("changeOrderStatus — persiste solo transiciones válidas", () => {
  it("persiste la transición real vía el repositorio", async () => {
    const fixture = buildRestaurantFixture();
    const input: CreateOrderInput = {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Deb",
      customerPhone: "9990001111",
      customerAddress: "Calle 80 #30",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    };
    const order = await createOrder(fixture.repo, input);
    expect(order.status).toBe("pending");

    const updated = await changeOrderStatus(fixture.repo, fixture.organizationId, order, "preparando");
    expect(updated.status).toBe("preparando");

    const reread = await fixture.repo.findOrderById(fixture.organizationId, order.id);
    expect(reread?.status).toBe("preparando");
  });

  it("una transición inválida lanza y NUNCA toca el repositorio", async () => {
    const fixture = buildRestaurantFixture();
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Efra",
      customerPhone: "9990002222",
      customerAddress: "Calle 90 #40",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    });

    await expect(changeOrderStatus(fixture.repo, fixture.organizationId, order, "completado")).rejects.toThrow(OrderStatusTransitionError);

    const reread = await fixture.repo.findOrderById(fixture.organizationId, order.id);
    expect(reread?.status).toBe("pending"); // nunca cambió
  });
});
