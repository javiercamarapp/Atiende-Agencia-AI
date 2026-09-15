// Fase 9 — notificaciones REALES de cambio de estado de pedido (ver diseño §1, gap
// verificado contra order-lifecycle.ts/admin-orders.ts: ni `changeOrderStatus` ni
// `changeAssignedOrderStatus` ni `createOrder` disparaban NUNCA ningún aviso — un
// cliente solo se enteraba de que su pedido iba en camino si alguien del staff lo
// llamaba, y un manager solo se enteraba de un pedido nuevo si refrescaba el panel
// a mano).
//
// Dos canales, cada uno resuelto por SU propio mecanismo real:
//
// 1. CLIENTE — WhatsApp real vía `restaurantes.messaging_outbox` (migrations/007),
//    el MISMO dispatcher que ya despacha `whatsapp.inbound_reply` (ver
//    whatsapp/inbound.ts) y que citas/hoteles ya usan para recordatorios
//    (domain-citas/src/reminders.ts). Nunca inventa un canal nuevo.
//
// 2. STAFF — sin push real disponible en este monorepo (no hay ningún SDK de
//    push/websocket compartido entre verticales, ver README de este paquete):
//    se persiste como bandeja consultable/reconocible por POLLING desde el panel
//    admin, mismo criterio "honesto" ya usado por
//    `@atiende/domain-licitaciones::tender_change_notification` — nunca finge un
//    canal de envío que no existe (ver migrations/009_order_notifications.sql para
//    la justificación completa de esta decisión).
//
// Todas las funciones "core" pueden lanzar (dejan ver el error real); las variantes
// `try*` son las que de verdad se llaman desde las rutas HTTP/el flujo de creación de
// pedido — best-effort real, nunca deben tumbar la operación principal (crear el
// pedido, mover el estado) solo porque el AVISO falló. Mismo patrón exacto que
// `@atiende/domain-citas::appointment-email-notifications.ts::tryEnqueueAppointmentEmail`.
import { correoConfirmacionPedido } from "./emails/order-templates.ts";
import type { Order, OrderStatus } from "./types.ts";
import type { RestaurantesRepository, StaffOrderNotificationEventType } from "./repository.ts";

function branchSuffix(order: Order): string {
  return order.branch ? ` de ${order.branch}` : "";
}

function greeting(order: Order): string {
  return order.customerName ? `Hola ${order.customerName}, ` : "Hola, ";
}

function formatMxn(amount: number): string {
  return `$${amount.toFixed(2)} MXN`;
}

/** Estados reales (de los 7 de `ORDER_STATUSES`, ver order-lifecycle.ts) en los que
 * el CLIENTE recibe un WhatsApp — decisión de diseño Fase 9 §1: "confirmado" del gap
 * original se mapea a "preparando" (no existe un status "confirmado" en el schema
 * real, migrations/001 — "preparando" ES la confirmación: la cocina ya tomó el
 * pedido). "pending" nunca notifica (todavía no hay nada que confirmar) y
 * "completado"/"problema" tampoco (completado es un cierre administrativo interno
 * sin novedad para el cliente que ya recibió su "entregado"; problema normalmente
 * implica una llamada real del repartidor/staff, no un WhatsApp automático — ver
 * comentario de cabecera). */
const CUSTOMER_NOTIFIED_STATUSES: ReadonlySet<OrderStatus> = new Set(["preparando", "en_camino", "entregado", "cancelado"]);

function customerMessageForStatus(order: Order): string | null {
  switch (order.status) {
    case "preparando":
      return `${greeting(order)}tu pedido${branchSuffix(order)} (${formatMxn(order.total)}) fue confirmado y ya lo estamos preparando.`;
    case "en_camino":
      return `${greeting(order)}tu pedido${branchSuffix(order)} va en camino.`;
    case "entregado":
      return `${greeting(order)}tu pedido${branchSuffix(order)} fue entregado. ¡Buen provecho!`;
    case "cancelado":
      return `${greeting(order)}tu pedido${branchSuffix(order)} fue cancelado. Si tienes dudas, contáctanos.`;
    default:
      return null;
  }
}

export interface CustomerOrderNotificationResult {
  readonly enqueued: boolean;
  readonly reason?: "status_not_notified" | "no_customer_phone" | "no_whatsapp_channel";
}

/**
 * Encola (si aplica) el WhatsApp real al cliente para el estado ACTUAL de `order`
 * (el caller pasa el pedido YA actualizado — mismo criterio que
 * `changeOrderStatus`/`changeAssignedOrderStatus` devuelven el pedido post-persistencia).
 * `dedupeKey` incluye el status para que dos transiciones reales del MISMO pedido
 * (p.ej. preparando y luego en_camino) generen dos mensajes reales — nunca se
 * pisan entre sí — pero un reintento idéntico (mismo pedido, mismo status) nunca
 * duplica (mismo dedupe real que `reminders.ts::runConfirmacionCitaCore`).
 *
 * Hallazgo de auditoría (rubro 17, comunicación transaccional, severidad MEDIA,
 * "soporte de plantillas HSM de WhatsApp ausente"): este envío es PROACTIVO (el
 * negocio inicia la conversación al cambiar el estado del pedido) — incluso cuando
 * `order` se originó por voz/web/admin, sin NINGÚN mensaje de WhatsApp previo de
 * este cliente que abra la ventana de 24h de Meta. `MetaGraphWhatsAppClient`
 * (`@atiende/whatsapp-gateway`) todavía no sabe enviar `type: "template"` — ver el
 * comentario de cabecera de
 * `packages/whatsapp-gateway/src/providers/meta-graph-client.ts` (o el README de
 * ese paquete) para el gap completo. Comportamiento actual honesto: Meta real
 * rechaza este envío fuera de ventana con un 4xx de negocio, el dispatcher lo marca
 * `dead` (nunca `sent` fingido) — la notificación simplemente no le llega al
 * cliente por WhatsApp hasta que exista una plantilla real aprobada.
 */
export async function notifyCustomerOnOrderStatusChangeCore(repo: RestaurantesRepository, order: Order): Promise<CustomerOrderNotificationResult> {
  if (!CUSTOMER_NOTIFIED_STATUSES.has(order.status)) return { enqueued: false, reason: "status_not_notified" };
  if (!order.customerPhone) return { enqueued: false, reason: "no_customer_phone" };

  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(order.organizationId);
  if (!phoneNumberId) return { enqueued: false, reason: "no_whatsapp_channel" };

  const message = customerMessageForStatus(order);
  if (!message) return { enqueued: false, reason: "status_not_notified" };

  await repo.enqueueMessagingOutbox(order.organizationId, "whatsapp", `order.status.${order.status}`, `order-status:${order.id}:${order.status}`, {
    to: order.customerPhone,
    phone_number_id: phoneNumberId,
    body: message,
  });
  return { enqueued: true };
}

/** Variante best-effort — la que de verdad llaman `order-lifecycle.ts::changeOrderStatus`
 * y `changeAssignedOrderStatus` (el único choke point real de TODA transición de
 * estado, venga del panel admin o del repartidor, ver ambos archivos): un fallo real
 * al encolar el aviso NUNCA debe revertir la transición de estado que sí es la
 * operación de negocio solicitada. */
export async function tryNotifyCustomerOnOrderStatusChange(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await notifyCustomerOnOrderStatusChangeCore(repo, order);
  } catch (err) {
    console.error("order-notifications: best-effort customer WhatsApp enqueue failed:", err);
  }
}

async function enqueueStaffNotification(repo: RestaurantesRepository, order: Order, eventType: StaffOrderNotificationEventType, message: string): Promise<void> {
  await repo.createStaffOrderNotification(order.organizationId, order.propertyId, order.id, eventType, message);
}

/** "Nuevo pedido entrante" — el caso real más urgente del gap (ver diseño Fase 9
 * §2): hasta esta fase, un pedido nuevo (source web/voice/whatsapp/admin) nunca
 * generaba NINGÚN aviso al staff, solo aparecía si alguien refrescaba el panel. */
export async function notifyStaffNewOrderCore(repo: RestaurantesRepository, order: Order): Promise<void> {
  await enqueueStaffNotification(repo, order, "order.created", `Nuevo pedido de ${order.customerName}${branchSuffix(order)} — ${formatMxn(order.total)}.`);
}

export async function tryNotifyStaffNewOrder(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await notifyStaffNewOrderCore(repo, order);
  } catch (err) {
    console.error("order-notifications: best-effort staff order.created failed:", err);
  }
}

/** Incidencia reportada (status="problema", casi siempre por el repartidor en
 * ruta) — el otro caso real de urgencia genuina para el staff: alguien tiene que
 * intervenir YA (ver order-lifecycle.ts::changeAssignedOrderStatus, que exige
 * `incidentNote` real para llegar aquí). */
export async function notifyStaffOrderProblemCore(repo: RestaurantesRepository, order: Order): Promise<void> {
  await enqueueStaffNotification(repo, order, "order.problema", `Incidencia en el pedido de ${order.customerName}${branchSuffix(order)}${order.incidentNote ? `: ${order.incidentNote}` : "."}`);
}

export async function tryNotifyStaffOrderProblem(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await notifyStaffOrderProblemCore(repo, order);
  } catch (err) {
    console.error("order-notifications: best-effort staff order.problema failed:", err);
  }
}

/**
 * "Pedido listo para repartidor" del gap original — DESVIACIÓN DOCUMENTADA
 * (mismo criterio que order-lifecycle.ts::assertValidRepartidorStatusTransition):
 * los 7 estados reales de `ORDER_STATUSES` (migrations/001) NO incluyen un estado
 * "listo" — ningún caller real dispara ese evento hoy. El momento REAL más cercano
 * en el flujo existente es el dispatch en sí (`assignRepartidorToOrder`,
 * admin-orders.ts `POST .../assign-repartidor`): ahí es cuando el pedido queda
 * genuinamente "listo para que el repartidor salga" con un repartidor real ya
 * asignado — se notifica ESE evento en vez de inventar un estado que no existe.
 */
export async function notifyStaffRepartidorAssignedCore(repo: RestaurantesRepository, order: Order): Promise<void> {
  await enqueueStaffNotification(repo, order, "order.assigned_repartidor", `Pedido de ${order.customerName}${branchSuffix(order)} asignado a repartidor — listo para salir.`);
}

export async function tryNotifyStaffRepartidorAssigned(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await notifyStaffRepartidorAssignedCore(repo, order);
  } catch (err) {
    console.error("order-notifications: best-effort staff order.assigned_repartidor failed:", err);
  }
}

// ============================================================================
// Fase de correo — CONFIRMACIÓN DE PEDIDO POR CORREO (hallazgo de auditoría,
// severidad MEDIA): "restaurantes no envía ningún correo: sin plantilla, sin
// dispatcher, sin remitente — solo WhatsApp". A diferencia de las notificaciones
// de arriba (WhatsApp real vía messaging_outbox / bandeja de staff), esta es la
// PRIMERA vez que este dominio encola `channel: 'email'` — ver
// emails/order-templates.ts y migrations/011_email_outbox_dispatch.sql (agrega
// `restaurantes.orders.customer_email`, capturado hoy solo desde el canal
// `web`, ver orders.ts::validateCreateOrderPayload).
//
// Mismo criterio de "sin correo en archivo no es un error" que
// @atiende/domain-citas::appointment-email-notifications.ts::
// enqueueAppointmentEmailCore: la mayoría de clientes de este vertical solo
// dejan teléfono (voz/WhatsApp) — el correo de confirmación simplemente no
// aplica para ellos, la confirmación por WhatsApp (arriba) ya los cubre.
// ============================================================================

export interface CustomerOrderConfirmationEmailResult {
  readonly enqueued: boolean;
  readonly reason?: "no_email";
}

/**
 * Encola (si el cliente dejó correo real) la confirmación de pedido —
 * SIEMPRE en el momento de creación, nunca por cambio de estado (a diferencia
 * de `notifyCustomerOnOrderStatusChangeCore`, que reacciona a transiciones):
 * el gap real es "el cliente nunca recibe nada al hacer su pedido si no dejó
 * WhatsApp/teléfono verificable", no un aviso de progreso. `dedupeKey` fijo por
 * pedido (sin status) porque este evento ocurre una sola vez en la vida de un
 * pedido — nunca hay una segunda "confirmación de creación" real que deba
 * generar un segundo correo.
 */
export async function notifyCustomerOrderConfirmationEmailCore(repo: RestaurantesRepository, order: Order): Promise<CustomerOrderConfirmationEmailResult> {
  if (!order.customerEmail) return { enqueued: false, reason: "no_email" };

  const correo = correoConfirmacionPedido({
    clienteNombre: order.customerName,
    branch: order.branch,
    items: order.items,
    total: order.total,
    customerAddress: order.customerAddress,
    paymentMethod: order.paymentMethod,
  });

  await repo.enqueueMessagingOutbox(order.organizationId, "email", "order.created.email", `order-confirmation:${order.id}`, {
    to: order.customerEmail,
    subject: correo.asunto,
    html: correo.html,
    text: correo.texto,
  });
  return { enqueued: true };
}

/** Variante best-effort — la que de verdad llama `orders.ts::createOrder`: un
 * pedido YA se creó con éxito en la base de datos; que el cliente no haya
 * dejado correo, o que esto falle por cualquier otra razón, NUNCA debe
 * convertirse en un error para quien está creando el pedido. Mismo principio
 * que `tryNotifyStaffNewOrder` de arriba. */
export async function tryNotifyCustomerOrderConfirmationEmail(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await notifyCustomerOrderConfirmationEmailCore(repo, order);
  } catch (err) {
    console.error("order-notifications: best-effort customer order confirmation email enqueue failed:", err);
  }
}
