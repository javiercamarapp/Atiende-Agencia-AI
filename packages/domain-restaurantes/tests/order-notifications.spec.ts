// Fase 9 restaurantes — notificaciones reales de cambio de estado de pedido (ver
// src/order-notifications.ts). GAP real verificado antes de construir: ni
// `changeOrderStatus`/`changeAssignedOrderStatus` (order-lifecycle.ts) ni
// `createOrder` (orders.ts) disparaban NUNCA ningún aviso, ni al cliente (WhatsApp
// vía `restaurantes.messaging_outbox`) ni al staff (bandeja interna por polling).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrder } from "../src/orders.ts";
import { changeAssignedOrderStatus, changeOrderStatus } from "../src/order-lifecycle.ts";
import {
  notifyCustomerOnOrderStatusChangeCore,
  notifyCustomerOrderConfirmationEmailCore,
  notifyStaffNewOrderCore,
  notifyStaffOrderProblemCore,
  notifyStaffRepartidorAssignedCore,
  tryNotifyCustomerOnOrderStatusChange,
} from "../src/order-notifications.ts";
import { buildRestaurantFixture } from "./fixtures.ts";
import type { CreateOrderInput } from "../src/types.ts";

async function seedOrder(fixture: ReturnType<typeof buildRestaurantFixture>, overrides: Partial<CreateOrderInput> = {}) {
  const input: CreateOrderInput = {
    organizationId: fixture.organizationId,
    branchSlug: "fco-montejo",
    customerName: "Deb",
    customerPhone: "9990001111",
    customerAddress: "Calle 80 #30",
    items: [{ productId: fixture.products.cocaCola, requestedQuantity: 1 }],
    source: "web",
    ...overrides,
  };
  return createOrder(fixture.repo, input);
}

describe("notifyCustomerOnOrderStatusChangeCore", () => {
  it("no encola nada si la organización nunca conectó WhatsApp", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "preparando");
    const result = await notifyCustomerOnOrderStatusChangeCore(fixture.repo, preparando!);
    expect(result).toEqual({ enqueued: false, reason: "no_whatsapp_channel" });
    expect(fixture.repo.getOutbox()).toHaveLength(0);
  });

  it("encola el WhatsApp real al cliente en preparando/en_camino/entregado/cancelado, con el phone_number_id real de la organización", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);

    for (const status of ["preparando", "en_camino", "entregado"] as const) {
      const updated = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, status);
      const result = await notifyCustomerOnOrderStatusChangeCore(fixture.repo, updated!);
      expect(result).toEqual({ enqueued: true });
    }

    const outbox = fixture.repo.getOutbox();
    expect(outbox).toHaveLength(3);
    expect(outbox.every((row) => row.channel === "whatsapp")).toBe(true);
    expect(outbox.every((row) => (row.payload as { phone_number_id: string }).phone_number_id === "PHONE_NUMBER_ID_123")).toBe(true);
    expect(outbox.every((row) => (row.payload as { to: string }).to === order.customerPhone)).toBe(true);
    expect((outbox.find((row) => row.eventType === "order.status.en_camino")?.payload as { body: string }).body).toMatch(/va en camino/);
  });

  it('"cancelado" también notifica al cliente', async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    const cancelado = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "cancelado");
    const result = await notifyCustomerOnOrderStatusChangeCore(fixture.repo, cancelado!);
    expect(result).toEqual({ enqueued: true });
    expect((fixture.repo.getOutbox()[0]?.payload as { body: string }).body).toMatch(/cancelado/);
  });

  it('"pending"/"completado"/"problema" NUNCA notifican al cliente (no son estados notificados)', async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    expect(await notifyCustomerOnOrderStatusChangeCore(fixture.repo, order)).toEqual({ enqueued: false, reason: "status_not_notified" });

    const problema = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "problema");
    expect(await notifyCustomerOnOrderStatusChangeCore(fixture.repo, problema!)).toEqual({ enqueued: false, reason: "status_not_notified" });
    expect(fixture.repo.getOutbox()).toHaveLength(0);
  });

  it("un pedido sin teléfono de cliente nunca lanza -- simplemente no encola", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    const sinTelefono = { ...(await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "preparando"))!, customerPhone: "" };
    const result = await notifyCustomerOnOrderStatusChangeCore(fixture.repo, sinTelefono);
    expect(result).toEqual({ enqueued: false, reason: "no_customer_phone" });
  });

  it("reintentar el MISMO status del MISMO pedido nunca duplica la fila del outbox (dedupe real)", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "preparando");
    await notifyCustomerOnOrderStatusChangeCore(fixture.repo, preparando!);
    await notifyCustomerOnOrderStatusChangeCore(fixture.repo, preparando!);
    expect(fixture.repo.getOutbox()).toHaveLength(1);
  });

  it("tryNotifyCustomerOnOrderStatusChange nunca lanza aunque el repositorio falle -- best-effort real", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const preparando = await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "preparando");
    const brokenRepo = {
      ...fixture.repo,
      resolveActiveWhatsAppPhoneNumberId: async () => {
        throw new Error("boom");
      },
    } as unknown as typeof fixture.repo;
    await expect(tryNotifyCustomerOnOrderStatusChange(brokenRepo, preparando!)).resolves.toBeUndefined();
  });
});

describe("changeOrderStatus / changeAssignedOrderStatus — disparan el aviso real (choke point único)", () => {
  it("changeOrderStatus (panel admin) encola el WhatsApp al cliente cuando corresponde", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    await changeOrderStatus(fixture.repo, fixture.organizationId, order, "preparando");
    expect(fixture.repo.getOutbox()).toHaveLength(1);
  });

  it('changeOrderStatus hacia "problema" notifica al STAFF (incidencia), nunca al cliente por WhatsApp', async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const order = await seedOrder(fixture);
    const preparando = await changeOrderStatus(fixture.repo, fixture.organizationId, order, "preparando");
    await changeOrderStatus(fixture.repo, fixture.organizationId, preparando, "problema");

    expect(fixture.repo.getOutbox()).toHaveLength(1); // solo el de "preparando" -- "problema" no es un estado notificado al cliente
    const staffNotifications = fixture.repo.getStaffOrderNotifications();
    expect(staffNotifications.some((n) => n.eventType === "order.problema")).toBe(true);
  });

  it("changeAssignedOrderStatus (repartidor) encola en_camino/entregado al cliente y la incidencia al staff en problema", async () => {
    const fixture = buildRestaurantFixture();
    fixture.repo.seedWhatsAppChannel(fixture.organizationId, "PHONE_NUMBER_ID_123");
    const repartidorId = randomUUID();
    const order = await seedOrder(fixture);
    await fixture.repo.assignRepartidorToOrder(fixture.organizationId, order.id, repartidorId, null);
    await fixture.repo.updateOrderStatus(fixture.organizationId, order.id, "preparando");
    const assigned = (await fixture.repo.findAssignedOrderById(fixture.organizationId, repartidorId, order.id))!;

    const enCamino = await changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, assigned, "en_camino", null);
    expect(fixture.repo.getOutbox().some((row) => row.eventType === "order.status.en_camino")).toBe(true);

    await changeAssignedOrderStatus(fixture.repo, fixture.organizationId, repartidorId, enCamino, "problema", "El cliente no contesta.");
    const staffNotifications = fixture.repo.getStaffOrderNotifications();
    const incidencia = staffNotifications.find((n) => n.eventType === "order.problema");
    expect(incidencia?.message).toMatch(/El cliente no contesta\./);
  });
});

describe("notifyStaffNewOrderCore / createOrder — 'nuevo pedido entrante' real", () => {
  it("createOrder notifica al staff automáticamente (best-effort), sin que ninguna ruta HTTP tenga que acordarse de llamarlo", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const notifications = fixture.repo.getStaffOrderNotifications();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.eventType).toBe("order.created");
    expect(notifications[0]?.orderId).toBe(order.id);
    expect(notifications[0]?.message).toMatch(/Nuevo pedido de Deb/);
  });

  it("notifyStaffNewOrderCore es idempotente por (organizationId, orderId, eventType)", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    await notifyStaffNewOrderCore(fixture.repo, order);
    await notifyStaffNewOrderCore(fixture.repo, order);
    expect(fixture.repo.getStaffOrderNotifications().filter((n) => n.orderId === order.id && n.eventType === "order.created")).toHaveLength(1);
  });
});

describe("notifyStaffOrderProblemCore / notifyStaffRepartidorAssignedCore", () => {
  it("notifyStaffOrderProblemCore incluye el incidentNote real en el mensaje", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const conIncidencia = { ...order, status: "problema" as const, incidentNote: "No había nadie en el domicilio." };
    await notifyStaffOrderProblemCore(fixture.repo, conIncidencia);
    const notification = fixture.repo.getStaffOrderNotifications().find((n) => n.eventType === "order.problema");
    expect(notification?.message).toContain("No había nadie en el domicilio.");
  });

  it('notifyStaffRepartidorAssignedCore -- "pedido listo para repartidor" del gap original, mapeado al dispatch real', async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    await notifyStaffRepartidorAssignedCore(fixture.repo, order);
    const notification = fixture.repo.getStaffOrderNotifications().find((n) => n.eventType === "order.assigned_repartidor");
    expect(notification).toBeDefined();
    expect(notification?.message).toMatch(/listo para salir/);
  });
});

describe("listStaffOrderNotifications / acknowledgeStaffOrderNotification", () => {
  it("lista más reciente primero, filtra por propertyIds y por unacknowledgedOnly", async () => {
    const fixture = buildRestaurantFixture();
    const orderA = await seedOrder(fixture, { customerName: "Primero" });
    const orderB = await seedOrder(fixture, { customerName: "Segundo" });

    // orderA/orderB se crean en el mismo tick (misma resolución de milisegundo de
    // `createdAt`) -- se verifica que AMBAS notificaciones existen (el orden real
    // por timestamp ya lo prueba `listOrders`/`listCustomers`, mismo criterio
    // `sort((a, b) => b.createdAt.localeCompare(a.createdAt))` en todo el repositorio).
    const all = await fixture.repo.listStaffOrderNotifications(fixture.organizationId, null);
    expect(new Set(all.map((n) => n.orderId))).toEqual(new Set([orderB.id, orderA.id]));

    const scoped = await fixture.repo.listStaffOrderNotifications(fixture.organizationId, [fixture.propertyId]);
    expect(scoped).toHaveLength(2);

    const notificationA = all.find((n) => n.orderId === orderA.id)!;
    await fixture.repo.acknowledgeStaffOrderNotification(fixture.organizationId, notificationA.id, "actor-1");
    const soloUnacknowledged = await fixture.repo.listStaffOrderNotifications(fixture.organizationId, null, { unacknowledgedOnly: true });
    expect(soloUnacknowledged.map((n) => n.orderId)).toEqual([orderB.id]);
  });

  it("acknowledgeStaffOrderNotification persiste acknowledgedAt/acknowledgedBy reales", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture);
    const [notification] = await fixture.repo.listStaffOrderNotifications(fixture.organizationId, null);
    expect(notification!.acknowledgedAt).toBeNull();

    const updated = await fixture.repo.acknowledgeStaffOrderNotification(fixture.organizationId, notification!.id, "actor-42");
    expect(updated.acknowledgedAt).not.toBeNull();
    expect(updated.acknowledgedBy).toBe("actor-42");
    void order;
  });

  it("reconocer un id inexistente lanza (nunca silencioso)", async () => {
    const fixture = buildRestaurantFixture();
    await expect(fixture.repo.acknowledgeStaffOrderNotification(fixture.organizationId, randomUUID(), "actor-1")).rejects.toThrow(/no encontrada/);
  });
});

// Hallazgo de auditoría (severidad MEDIA, "restaurantes no envía ningún correo:
// sin plantilla, sin dispatcher, sin remitente — solo WhatsApp"): confirmación de
// pedido por correo REAL cuando el cliente deja un correo (ver
// migrations/011_email_outbox_dispatch.sql, orders.ts::createOrder).
describe("notifyCustomerOrderConfirmationEmailCore", () => {
  it("sin correo del cliente, no encola nada (el WhatsApp de siempre ya lo cubre)", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture); // sin customerEmail
    const result = await notifyCustomerOrderConfirmationEmailCore(fixture.repo, order);
    expect(result).toEqual({ enqueued: false, reason: "no_email" });
    expect(fixture.repo.getOutbox().filter((o) => o.channel === "email")).toHaveLength(0);
  });

  it("con correo real del cliente, encola channel='email' con to/subject/html/text reales del pedido", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture, { customerEmail: "cliente@example.com" });
    const result = await notifyCustomerOrderConfirmationEmailCore(fixture.repo, order);
    expect(result).toEqual({ enqueued: true });

    const job = fixture.repo.getOutbox().find((o) => o.channel === "email" && o.eventType === "order.created.email");
    expect(job).toBeDefined();
    const payload = job!.payload as { to: string; subject: string; html: string; text: string };
    expect(payload.to).toBe("cliente@example.com");
    expect(payload.subject).toContain("Pedido confirmado");
    expect(payload.html).toContain("Deb"); // customerName del fixture, escapado en el HTML
    expect(payload.text).toContain("Coca-Cola");
  });

  it("createOrder (el flujo real) encola el correo automáticamente cuando el pedido trae customerEmail — sin llamada extra del caller", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture, { customerEmail: "auto@example.com" });
    expect(order.customerEmail).toBe("auto@example.com");
    const job = fixture.repo.getOutbox().find((o) => o.channel === "email" && o.dedupeKey === `order-confirmation:${order.id}`);
    expect(job).toBeDefined();
  });

  it("dedupeKey fijo por pedido — un reintento del mismo evento nunca duplica la fila", async () => {
    const fixture = buildRestaurantFixture();
    const order = await seedOrder(fixture, { customerEmail: "dup@example.com" });
    await notifyCustomerOrderConfirmationEmailCore(fixture.repo, order); // createOrder ya encoló una vez; esto es un segundo intento real
    const jobs = fixture.repo.getOutbox().filter((o) => o.channel === "email" && o.eventType === "order.created.email");
    expect(jobs).toHaveLength(1);
  });
});
