// Fase 5 back-office CORE — máquina de estados real de un pedido (ver diseño
// §1.3). Cubre: transición válida persiste, transición inválida se rechaza SIN
// tocar el repositorio, y las transiciones terminales (cancelado/completado) nunca
// reabren.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import {
  assertValidOrderStatusTransition,
  assertValidRepartidorStatusTransition,
  changeAssignedOrderStatus,
  changeOrderStatus,
  isOrderStatus,
  nextValidStatuses,
  OrderStatusTransitionError,
  ORDER_STATUSES,
  REPARTIDOR_ALLOWED_STATUSES,
} from "../src/order-lifecycle.ts";
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

// Fase 8 — superficie real del rol "repartidor" (ver roles.ts::REPARTIDOR_ROLES): un
// subconjunto ESTRICTO de las transiciones generales, y acotado a SU pedido
// asignado (ver repository.ts::updateAssignedOrderStatus).
describe("REPARTIDOR_ALLOWED_STATUSES / assertValidRepartidorStatusTransition", () => {
  it("un repartidor solo puede fijar en_camino/entregado/problema como destino — nunca preparando/cancelado/completado (movimientos de gestión)", () => {
    expect(REPARTIDOR_ALLOWED_STATUSES).toEqual(["en_camino", "entregado", "problema"]);
    expect(() => assertValidRepartidorStatusTransition("pending", "preparando")).toThrow(OrderStatusTransitionError);
    expect(() => assertValidRepartidorStatusTransition("pending", "cancelado")).toThrow(OrderStatusTransitionError);
    expect(() => assertValidRepartidorStatusTransition("entregado", "completado")).toThrow(OrderStatusTransitionError);
  });

  it("preparando -> en_camino -> entregado, el avance real de una entrega", () => {
    expect(() => assertValidRepartidorStatusTransition("preparando", "en_camino")).not.toThrow();
    expect(() => assertValidRepartidorStatusTransition("en_camino", "entregado")).not.toThrow();
  });

  it("DESVIACIÓN DELIBERADA vs. el origen: pending -> en_camino directo se rechaza (la máquina unificada de Fase 5 exige pasar por 'preparando' para CUALQUIER caller, ver comentario de cabecera)", () => {
    expect(() => assertValidRepartidorStatusTransition("pending", "en_camino")).toThrow(OrderStatusTransitionError);
  });

  it("'problema' disponible desde pending/preparando/en_camino, igual que la máquina general", () => {
    expect(() => assertValidRepartidorStatusTransition("pending", "problema")).not.toThrow();
    expect(() => assertValidRepartidorStatusTransition("preparando", "problema")).not.toThrow();
    expect(() => assertValidRepartidorStatusTransition("en_camino", "problema")).not.toThrow();
    // "problema" nunca es un destino válido DESDE sí mismo ni desde un estado ya
    // terminal -- delega en la máquina general, que ya lo cubre.
    expect(() => assertValidRepartidorStatusTransition("entregado", "problema")).not.toThrow();
    expect(() => assertValidRepartidorStatusTransition("cancelado", "problema")).toThrow(OrderStatusTransitionError);
  });
});

describe("changeAssignedOrderStatus — persiste solo lo válido, acotado al repartidor asignado", () => {
  async function seedAssignedOrder(status: "pending" | "preparando" | "en_camino" = "preparando") {
    const fixture = buildRestaurantFixture();
    const repartidorId = randomUUID();
    const order = await createOrder(fixture.repo, {
      organizationId: fixture.organizationId,
      branchSlug: "fco-montejo",
      customerName: "Gina",
      customerPhone: "9990003333",
      customerAddress: "Calle 21 #50",
      items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
      source: "web",
    } satisfies CreateOrderInput);
    await fixture.repo.assignRepartidorToOrder(fixture.organizationId, order.id, repartidorId, null);
    if (status !== "pending") {
      await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "preparando");
    }
    if (status === "en_camino") {
      await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "en_camino");
    }
    const assigned = await fixture.repo.findAssignedOrderById(fixture.organizationId, repartidorId, order.id);
    return { fixture, repartidorId, order: assigned! };
  }

  it("preparando -> en_camino, sin incidentNote", async () => {
    const { fixture, repartidorId, order } = await seedAssignedOrder("preparando");
    const updated = await changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, order, "en_camino", null);
    expect(updated.status).toBe("en_camino");
    expect(updated.incidentNote).toBeNull();
  });

  it('"problema" exige incidentNote real (1-2000 caracteres) — vacío o ausente se rechaza SIN tocar el repositorio', async () => {
    const { fixture, repartidorId, order } = await seedAssignedOrder("en_camino");
    await expect(changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, order, "problema", null)).rejects.toThrow(OrderStatusTransitionError);
    await expect(changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, order, "problema", "   ")).rejects.toThrow(OrderStatusTransitionError);

    const reread = await fixture.repo.findAssignedOrderById(fixture.organizationId, repartidorId, order.id);
    expect(reread?.status).toBe("en_camino"); // nunca cambió

    const updated = await changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, order, "problema", "El cliente no contesta.");
    expect(updated.status).toBe("problema");
    expect(updated.incidentNote).toBe("El cliente no contesta.");
  });

  it("un incidentNote fuera de 'problema' se rechaza (solo aplica a esa transición)", async () => {
    const { fixture, repartidorId, order } = await seedAssignedOrder("preparando");
    await expect(changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, order, "en_camino", "esto no debería ir aquí")).rejects.toThrow(OrderStatusTransitionError);
  });

  it("un repartidor NUNCA puede tocar un pedido asignado a OTRO repartidor -- el repositorio no encuentra la fila y lanza", async () => {
    const { fixture, order } = await seedAssignedOrder("preparando");
    const otroRepartidorId = randomUUID();
    await expect(changeAssignedOrderStatus(fixture.repo, fixture.organizationId, otroRepartidorId, order, "en_camino", null)).rejects.toThrow(/ya no existe o ya no está asignado/);
  });

  it("pending -> en_camino se rechaza (debe pasar por preparando, ver desviación documentada arriba)", async () => {
    const { fixture, repartidorId, order } = await seedAssignedOrder("pending");
    await expect(changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, order, "en_camino", null)).rejects.toThrow(OrderStatusTransitionError);
  });
});
