// PM PR-3 (b)(d): estados del canal recoger (listo_para_recoger / no_recogido -> vuelve a cocina), aviso
// opcional al cliente, y canal / propina / hora de recogida como datos del pedido.
import { describe, expect, it } from "vitest";
import { OrderValidationError } from "../src/errors.ts";
import { assertValidOrderStatusTransition, changeOrderStatus, esPedidoParaRecoger, nextValidStatuses, OrderStatusTransitionError } from "../src/order-lifecycle.ts";
import { createOrder, validateCreateOrderPayload } from "../src/orders.ts";
import type { CreateOrderInput } from "../src/types.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

function input(f: ReturnType<typeof buildRestaurantFixture>, overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    organizationId: f.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Ana",
    customerPhone: "9990001111",
    items: [{ productId: f.products.cocaCola, requestedQuantity: 1 }],
    source: "whatsapp",
    paymentMethod: "tarjeta",
    canal: "recoger",
    ...overrides,
  };
}

describe("transiciones del canal recoger", () => {
  it("preparando -> listo_para_recoger -> entregado, y listo_para_recoger -> no_recogido", () => {
    expect(() => assertValidOrderStatusTransition("preparando", "listo_para_recoger")).not.toThrow();
    expect(() => assertValidOrderStatusTransition("listo_para_recoger", "entregado")).not.toThrow();
    expect(() => assertValidOrderStatusTransition("listo_para_recoger", "no_recogido")).not.toThrow();
  });

  it("no_recogido vuelve a cocina (preparando) o se cancela; nunca salta a entregado", () => {
    expect(nextValidStatuses("no_recogido")).toEqual(["preparando", "cancelado"]);
    expect(() => assertValidOrderStatusTransition("no_recogido", "entregado")).toThrow(OrderStatusTransitionError);
  });

  it("pending no salta directo a listo_para_recoger (pasa por cocina)", () => {
    expect(() => assertValidOrderStatusTransition("pending", "listo_para_recoger")).toThrow(OrderStatusTransitionError);
  });
});

describe("changeOrderStatus con pedidos de recoger", () => {
  it("ciclo completo: pending -> preparando -> listo -> no recogido -> vuelve a cocina -> listo -> entregado", async () => {
    const f = buildRestaurantFixture();
    let order = await createOrder(f.repo, input(f));
    for (const next of ["preparando", "listo_para_recoger", "no_recogido", "preparando", "listo_para_recoger", "entregado"] as const) {
      order = await changeOrderStatus(f.repo, f.organizationId, order, next);
      expect(order.status).toBe(next);
    }
    expect((await f.repo.findOrderById(f.organizationId, order.id))?.status).toBe("entregado");
  });

  it("un pedido para recoger no sale 'en_camino'", async () => {
    const f = buildRestaurantFixture();
    let order = await createOrder(f.repo, input(f));
    order = await changeOrderStatus(f.repo, f.organizationId, order, "preparando");
    await expect(changeOrderStatus(f.repo, f.organizationId, order, "en_camino")).rejects.toThrow(/recoger no sale "en_camino"/);
  });

  it("un pedido A DOMICILIO no puede marcarse listo_para_recoger", async () => {
    const f = buildRestaurantFixture();
    let order = await createOrder(f.repo, input(f, { canal: "domicilio", customerAddress: "Calle 5 #1", paymentMethod: "efectivo" }));
    order = await changeOrderStatus(f.repo, f.organizationId, order, "preparando");
    await expect(changeOrderStatus(f.repo, f.organizationId, order, "listo_para_recoger")).rejects.toThrow(/solo aplica a pedidos para recoger/);
    expect((await f.repo.findOrderById(f.organizationId, order.id))?.status).toBe("preparando");
  });

  it("un pedido historico SIN canal conocido no se bloquea (nunca se rompe un flujo que hoy funciona)", () => {
    expect(esPedidoParaRecoger({ notes: null }, null)).toBeNull();
    expect(esPedidoParaRecoger({ notes: "Canal: recoger en sucursal." }, { canal: null })).toBe(true);
    expect(esPedidoParaRecoger({ notes: "Canal: domicilio." }, { canal: "domicilio" })).toBe(false);
  });

  it("aviso al cliente por WhatsApp al quedar listo: por defecto SI, y es opcional (avisarCliente:false)", async () => {
    for (const avisar of [true, false]) {
      const f = buildRestaurantFixture();
      f.repo.seedWhatsAppChannel(f.organizationId, "PN-1");
      let order = await createOrder(f.repo, input(f));
      order = await changeOrderStatus(f.repo, f.organizationId, order, "preparando");
      await f.repo.claimMessagingOutboxBatch(50, 60);
      await changeOrderStatus(f.repo, f.organizationId, order, "listo_para_recoger", undefined, { avisarCliente: avisar });
      const filas = await f.repo.claimMessagingOutboxBatch(50, 60);
      const avisos = filas.filter((r) => String((r.payload as { body?: string }).body ?? "").includes("listo para recoger"));
      expect(avisos).toHaveLength(avisar ? 1 : 0);
    }
  });

  it("no_recogido NO avisa al cliente", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedWhatsAppChannel(f.organizationId, "PN-1");
    let order = await createOrder(f.repo, input(f));
    order = await changeOrderStatus(f.repo, f.organizationId, order, "preparando");
    order = await changeOrderStatus(f.repo, f.organizationId, order, "listo_para_recoger", undefined, { avisarCliente: false });
    await f.repo.claimMessagingOutboxBatch(50, 60);
    await changeOrderStatus(f.repo, f.organizationId, order, "no_recogido");
    // Ya se vacio la cola antes de la transicion: cualquier fila nueva seria un aviso por no_recogido.
    expect(await f.repo.claimMessagingOutboxBatch(50, 60)).toHaveLength(0);
  });
});

describe("canal, propina y hora de recogida como datos del pedido", () => {
  it("se persisten como columnas (ademas de las notas) y se leen con listOrderPickupInfo", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    const hora = new Date(Date.now() + 45 * 60_000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    const order = await createOrder(f.repo, input(f, { propina: 12.5, horaRecogida: hora }));
    expect(order).toMatchObject({ canal: "recoger", propina: 12.5, horaRecogida: hora });
    expect(order.notes).toMatch(/Propina: \$12\.50/);
    expect(order.notes).toContain(`Hora de recogida: ${hora}`);
    expect(await f.repo.listOrderPickupInfo(f.organizationId, [order.id])).toEqual([{ orderId: order.id, canal: "recoger", propina: 12.5, horaRecogida: hora }]);
  });

  it("un pedido sin canal explicito queda con canal null y propina null (historico)", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, input(f, { canal: undefined, customerAddress: "Calle 5 #1", paymentMethod: "efectivo" }));
    expect(order.canal).toBeNull();
    expect(order.propina).toBeNull();
  });

  it("propina solo con tarjeta: con efectivo se rechaza y el pedido no se crea", async () => {
    const f = buildRestaurantFixture();
    f.repo.seedBranchPolicy(f.propertyId, { propinaPolitica: "solo_tarjeta" });
    await expect(createOrder(f.repo, input(f, { paymentMethod: "efectivo", propina: 10 }))).rejects.toThrow(/solo se registra cuando el pago es con tarjeta/);
    const ok = await createOrder(f.repo, input(f, { paymentMethod: "tarjeta", propina: 10 }));
    expect(ok.propina).toBe(10);
  });

  it("listOrderPickupInfo no cruza organizaciones", async () => {
    const f = buildRestaurantFixture();
    const order = await createOrder(f.repo, input(f));
    expect(await f.repo.listOrderPickupInfo("00000000-0000-4000-8000-000000000000", [order.id])).toEqual([]);
  });

  it("la hora de recogida solo aplica a recoger, con formato ISO y zona", () => {
    const base = { organizationId: "o", branchSlug: "s", customerName: "Ana", customerPhone: "9990001111", source: "web" as const, items: [{ productId: "11111111-1111-4111-8111-111111111111", requestedQuantity: 1 }] };
    expect(() => validateCreateOrderPayload({ ...base, canal: "domicilio", horaRecogida: "2026-09-30T20:30:00-06:00" })).toThrow(/solo aplica a pedidos para recoger/);
    expect(() => validateCreateOrderPayload({ ...base, canal: "recoger", horaRecogida: "manana a las 8" })).toThrow(OrderValidationError);
    expect(() => validateCreateOrderPayload({ ...base, canal: "recoger", horaRecogida: "2026-09-30T20:30:00" })).toThrow(/zona horaria/);
    expect(() => validateCreateOrderPayload({ ...base, canal: "recoger", horaRecogida: "2026-09-30T20:30:00-06:00" })).not.toThrow();
  });
});
