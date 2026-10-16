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
import { resolverZonaHorariaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { etiquetaHoraLocal } from "./horarios.ts";
import { toWhatsAppRecipient } from "./phone.ts";
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
const CUSTOMER_NOTIFIED_STATUSES: ReadonlySet<OrderStatus> = new Set(["preparando", "en_camino", "entregado", "cancelado", "listo_para_recoger"]);

/** Estados que reciben aviso al cliente (los de `CUSTOMER_NOTIFIED_STATUSES`); para reconocer, en un status de Meta, de que estado era el aviso. */
export function esEstadoNotificadoAlCliente(status: string): status is OrderStatus {
  return CUSTOMER_NOTIFIED_STATUSES.has(status as OrderStatus);
}

/** Frase del aviso de estado de pedido tal como salio por WhatsApp, SIN el saludo ("su pedido ... va en camino."), para el respaldo por correo. Solo
 *  usa nombre, sucursal, total y estado del pedido. */
export function frasePedidoParaEstado(order: Pick<Order, "customerName" | "branch" | "total" | "status">): string | null {
  const completo = customerMessageForStatus(order as Order);
  if (completo === null) return null;
  const saludo = greeting(order as Order);
  return completo.startsWith(saludo) ? completo.slice(saludo.length) : completo;
}

function customerMessageForStatus(order: Order): string | null {
  switch (order.status) {
    case "preparando":
      return `${greeting(order)}su pedido${branchSuffix(order)} (${formatMxn(order.total)}) fue confirmado y ya lo estamos preparando.`;
    case "en_camino":
      return `${greeting(order)}su pedido${branchSuffix(order)} va en camino.`;
    case "listo_para_recoger":
      return `${greeting(order)}su pedido${branchSuffix(order)} ya está listo para recoger en mostrador.`;
    case "entregado":
      return `${greeting(order)}su pedido${branchSuffix(order)} fue entregado. ¡Buen provecho!`;
    case "cancelado":
      return `${greeting(order)}su pedido${branchSuffix(order)} fue cancelado. Si tiene dudas, contáctenos.`;
    default:
      return null;
  }
}

/** R-27: plantillas HSM de WhatsApp (una por estado notificado) para el aviso de estado del pedido al cliente.
 * Variables del cuerpo, en este orden: {{1}} nombre del cliente, {{2}} sucursal, {{3}} total (por ejemplo
 * "$250.00 MXN"). Los nombres/idioma son los que hay que crear y aprobar en el Business Manager de Meta (paso
 * externo); hasta que el operador los declare en `WHATSAPP_APPROVED_TEMPLATES` el gateway envia el texto libre
 * de siempre (ver packages/whatsapp-gateway/README.md). */
export const PLANTILLAS_ESTADO_PEDIDO: Readonly<Partial<Record<OrderStatus, { readonly name: string; readonly language: string }>>> = {
  preparando: { name: "pedido_confirmado", language: "es_MX" },
  en_camino: { name: "pedido_en_camino", language: "es_MX" },
  listo_para_recoger: { name: "pedido_listo_para_recoger", language: "es_MX" },
  entregado: { name: "pedido_entregado", language: "es_MX" },
  cancelado: { name: "pedido_cancelado", language: "es_MX" },
};

/** Una variable de plantilla: sin saltos de linea ni tabuladores (Meta los rechaza), espacios colapsados, tope de
 * 1024 caracteres y nunca vacia (Meta rechaza variables vacias). */
function parametroPlantilla(valor: string | null | undefined, respaldo: string): string {
  const limpio = (valor ?? "").replace(/\s+/g, " ").trim().slice(0, 1024);
  return limpio.length > 0 ? limpio : respaldo;
}

/** Plantilla HSM del estado actual del pedido, o `undefined` si ese estado no tiene plantilla. */
export function plantillaParaEstado(order: Order): { readonly name: string; readonly language: string; readonly params: readonly string[] } | undefined {
  const base = PLANTILLAS_ESTADO_PEDIDO[order.status];
  if (!base) return undefined;
  return {
    ...base,
    params: [parametroPlantilla(order.customerName, "cliente"), parametroPlantilla(order.branch, "la sucursal"), formatMxn(order.total)],
  };
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
 * R-27 (rubro 17 de la auditoría, plantillas HSM): este envío es PROACTIVO (el negocio inicia la conversación
 * al cambiar el estado del pedido), incluso cuando `order` se originó por voz/web/admin, sin ningún mensaje de
 * WhatsApp previo de este cliente que abra la ventana de 24 h de Meta. Por eso el payload lleva, además del texto
 * libre (`body`, respaldo), la plantilla HSM del estado (`template`, ver `PLANTILLAS_ESTADO_PEDIDO`).
 * `MetaGraphWhatsAppClient` (`@atiende/whatsapp-gateway`) la envía como `type: "template"` SOLO si el operador
 * declaró esa plantilla aprobada por Meta (`WHATSAPP_APPROVED_TEMPLATES`); si no, sale el texto libre, que fuera
 * de la ventana Meta rechaza con un 4xx de negocio y el dispatcher marca `dead` (nunca `sent` fingido).
 */
export async function notifyCustomerOnOrderStatusChangeCore(repo: RestaurantesRepository, order: Order): Promise<CustomerOrderNotificationResult> {
  if (!CUSTOMER_NOTIFIED_STATUSES.has(order.status)) return { enqueued: false, reason: "status_not_notified" };
  if (!order.customerPhone) return { enqueued: false, reason: "no_customer_phone" };
  // El telefono guardado son 10 digitos nacionales: Meta exige el numero con codigo de pais (ver phone.ts).
  const recipient = toWhatsAppRecipient(order.customerPhone);
  if (!recipient) return { enqueued: false, reason: "no_customer_phone" };

  const phoneNumberId = await repo.resolveActiveWhatsAppPhoneNumberId(order.organizationId, order.propertyId);
  if (!phoneNumberId) return { enqueued: false, reason: "no_whatsapp_channel" };

  const message = customerMessageForStatus(order);
  if (!message) return { enqueued: false, reason: "status_not_notified" };
  const plantilla = plantillaParaEstado(order);

  await repo.enqueueMessagingOutbox(order.organizationId, "whatsapp", `order.status.${order.status}`, `order-status:${order.id}:${order.status}`, {
    to: recipient,
    phone_number_id: phoneNumberId,
    body: message,
    transaccional: true, // SA-L-46: estado de SU pedido; la lista de supresion no la bloquea.
    // R-27: el aviso es PROACTIVO (puede caer fuera de la ventana de 24 h): se declara la plantilla HSM del
    // estado y el gateway decide si usarla (solo si el operador la declaro aprobada); `body` es el respaldo.
    ...(plantilla ? { template: plantilla } : {}),
  });
  return { enqueued: true };
}

const NOTIFY_SAVEPOINT_NAME = "sp_order_notify_best_effort";

/**
 * Envuelve un best-effort en SAVEPOINT/ROLLBACK TO SAVEPOINT cuando corre dentro de
 * la MISMA transacción que el caller (mismo patrón exacto que `triggerInline` de
 * `apps/api/src/routes/internal/whatsapp-dispatch.ts`, hotfix auditoría a2b sobre
 * PR #169 — Blocker A). `changeOrderStatus`/`changeAssignedOrderStatus`
 * (order-lifecycle.ts) persisten el nuevo estado del pedido ANTES de llamar a
 * `tryNotify*` — en sesión de STAFF (admin-orders.ts/repartidor-orders.ts) ese
 * UPDATE vive en la MISMA transacción que este best-effort. Sin este SAVEPOINT, un
 * fallo real dentro del best-effort (p.ej. el SELECT de
 * `resolveActiveWhatsAppPhoneNumberId` contra `restaurantes.whatsapp_channel_config`
 * sin GRANT `select` a `authenticated` en la base real sin migrar, ver
 * postgres-repository.ts:631 y supabase/migrations/
 * 20240101000140_017_restaurantes_sistema_whatsapp_channel_config.sql) deja la
 * transacción COMPLETA abortada (25P02) — el `commit;` posterior de
 * `managed-postgres-engine.ts` lo detecta y lanza `AbortedTransactionCommitError`
 * (desde PR #158 esto es un 500 honesto, NUNCA un rollback silencioso con 2xx), y
 * el cambio de estado del pedido, ya "persistido" antes en la misma transacción,
 * se pierde de todas formas. El SAVEPOINT va DENTRO del try, mismo criterio que
 * `triggerInline`: si `db` ya traía la transacción abortada por una causa AJENA a
 * este best-effort, el propio `SAVEPOINT` también lanza 25P02 — se traga aquí
 * también, nunca se relanza (no es responsabilidad de este best-effort arreglar un
 * abort previo). `db` opcional existe solo por si un caller futuro de sesión de
 * SISTEMA reutiliza esta función sin transacción compartida que proteger -- hoy los
 * dos únicos callers reales (`order-lifecycle.ts::changeOrderStatus`/
 * `changeAssignedOrderStatus`) siempre lo pasan, en sesión de STAFF, con el UPDATE
 * del pedido en la MISMA transacción (CORRECCIÓN, auditoría a3: la versión anterior
 * de este comentario afirmaba que `createOrder` era un caller de sesión de sistema
 * que llegaba aquí "sin transacción de negocio que proteger" -- `createOrder` NUNCA
 * llama a `runNotifyBestEffort`; sus propios best-effort, más abajo en este archivo,
 * SÍ comparten transacción con el INSERT del pedido dentro de
 * `withAppSession({userId:null})` y se protegen con `repo.runWithRowSavepoint`, no
 * con este helper).
 */
async function runNotifyBestEffort(db: TenantDbSession | undefined, fn: () => Promise<void>, onError: (err: unknown) => void): Promise<void> {
  if (!db) {
    try {
      await fn();
    } catch (err) {
      onError(err);
    }
    return;
  }
  try {
    await db.exec(`SAVEPOINT ${NOTIFY_SAVEPOINT_NAME}`);
    await fn();
    await db.exec(`RELEASE SAVEPOINT ${NOTIFY_SAVEPOINT_NAME}`);
  } catch (err) {
    try {
      await db.exec(`ROLLBACK TO SAVEPOINT ${NOTIFY_SAVEPOINT_NAME}`);
      await db.exec(`RELEASE SAVEPOINT ${NOTIFY_SAVEPOINT_NAME}`);
    } catch (recoveryErr) {
      // Si el propio SAVEPOINT nunca llegó a crearse (transacción ya abortada de
      // entrada), este ROLLBACK TO también falla -- se traga aquí a propósito,
      // igual que triggerInline.
      console.error("order-notifications: fallo recuperando el SAVEPOINT del best-effort (no debería pasar):", recoveryErr);
    }
    onError(err);
  }
}

/** Variante best-effort — la que de verdad llaman `order-lifecycle.ts::changeOrderStatus`
 * y `changeAssignedOrderStatus` (el único choke point real de TODA transición de
 * estado, venga del panel admin o del repartidor, ver ambos archivos): un fallo real
 * al encolar el aviso NUNCA debe revertir la transición de estado que sí es la
 * operación de negocio solicitada. `db` (opcional) es el MISMO `TenantDbSession` de
 * la transacción del caller -- ver `runNotifyBestEffort` para por qué hace falta en
 * sesión de staff (Blocker A, revisión de PR #169). */
export async function tryNotifyCustomerOnOrderStatusChange(repo: RestaurantesRepository, order: Order, db?: TenantDbSession): Promise<void> {
  await runNotifyBestEffort(
    db,
    () => notifyCustomerOnOrderStatusChangeCore(repo, order).then(() => undefined),
    (err) => console.error("order-notifications: best-effort customer WhatsApp enqueue failed:", err),
  );
}

async function enqueueStaffNotification(repo: RestaurantesRepository, order: Order, eventType: StaffOrderNotificationEventType, message: string): Promise<void> {
  await repo.createStaffOrderNotification(order.organizationId, order.propertyId, order.id, eventType, message);
}

/** "Nuevo pedido entrante" — el caso real más urgente del gap (ver diseño Fase 9
 * §2): hasta esta fase, un pedido nuevo (source web/voice/whatsapp/admin) nunca
 * generaba NINGÚN aviso al staff, solo aparecía si alguien refrescaba el panel. */
export async function notifyStaffNewOrderCore(repo: RestaurantesRepository, order: Order): Promise<void> {
  // R-11: un pedido PROGRAMADO avisa que entra mas tarde (hora en la zona de la sucursal), no que hay que
  // prepararlo ya. El aviso reutiliza el evento `order.created` (el CHECK de la bandeja no admite otros).
  if (order.status === "programado" && order.programadoPara) {
    const zona = resolverZonaHorariaNegocio((await repo.findBranchZonaHoraria(order.propertyId)).zonaHoraria);
    await enqueueStaffNotification(
      repo,
      order,
      "order.created",
      `Nuevo pedido PROGRAMADO de ${order.customerName}${branchSuffix(order)} para ${etiquetaHoraLocal(new Date(order.programadoPara), zona)} — ${formatMxn(order.total)}.`,
    );
    return;
  }
  await enqueueStaffNotification(repo, order, "order.created", `Nuevo pedido de ${order.customerName}${branchSuffix(order)} — ${formatMxn(order.total)}.`);
}

/**
 * Best-effort real (`orders.ts::createOrder` es el único caller, tanto en sesión de
 * SISTEMA -- `public.ts`/`llm-turn-handler.ts`, ambos dentro de
 * `withAppSession({userId:null})` -- como reutilizado por cualquier caller futuro de
 * sesión de STAFF): un error real de Postgres dentro de `notifyStaffNewOrderCore`
 * (`enqueue_staff_order_notification`, ver migrations/009) sin este SAVEPOINT deja la
 * transacción COMPLETA del request abortada (25P02) — el pedido, YA insertado por
 * `createOrderIdempotent` antes de llegar aquí (misma transacción), se pierde con un
 * `commit;` que Postgres convierte en `ROLLBACK` (`AbortedTransactionCommitError`,
 * `managed-postgres-engine.ts`). `repo.runWithRowSavepoint` (ya expuesto por
 * `RestaurantesRepository`, ver postgres-repository.ts) aísla solo este intento:
 * si falla, hace `ROLLBACK TO SAVEPOINT` (deja la sesión utilizable de nuevo, el
 * pedido ya escrito sobrevive) y vuelve a lanzar el mismo error, que este `catch`
 * sigue tragando igual que antes -- nunca revierte la creación del pedido solo
 * porque el aviso al staff falló. Mismo criterio exacto que `runNotifyBestEffort`
 * de arriba, sin tocar la firma de esta función ni de sus callers.
 */
export async function tryNotifyStaffNewOrder(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await repo.runWithRowSavepoint(() => notifyStaffNewOrderCore(repo, order));
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

export async function tryNotifyStaffOrderProblem(repo: RestaurantesRepository, order: Order, db?: TenantDbSession): Promise<void> {
  await runNotifyBestEffort(
    db,
    () => notifyStaffOrderProblemCore(repo, order),
    (err) => console.error("order-notifications: best-effort staff order.problema failed:", err),
  );
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

/**
 * Best-effort real (`admin-orders.ts::POST .../assign-repartidor` es el único
 * caller, siempre en sesión de STAFF vía `c.get("db")`): mismo hueco y mismo
 * arreglo que `tryNotifyStaffNewOrder` de arriba -- sin SAVEPOINT, un error real
 * dentro de `notifyStaffRepartidorAssignedCore` aborta la transacción del request y
 * el dispatch al repartidor (`assignRepartidorToOrder`, ya persistido ANTES de
 * llamar aquí) se pierde con el request devolviendo un 500 honesto por rollback
 * (`AbortedTransactionCommitError`, PR #158) en vez de confirmar el dispatch.
 * `repo.runWithRowSavepoint` aísla el intento y relanza el mismo error para que este
 * `catch` lo siga tragando, con la sesión ya recuperada.
 */
export async function tryNotifyStaffRepartidorAssigned(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await repo.runWithRowSavepoint(() => notifyStaffRepartidorAssignedCore(repo, order));
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
    transaccional: true, // SA-L-46: confirmacion de SU pedido; la lista de supresion no la bloquea.
  });
  return { enqueued: true };
}

/**
 * Variante best-effort — la que de verdad llama `orders.ts::createOrder`: un
 * pedido YA se creó con éxito en la base de datos; que el cliente no haya
 * dejado correo, o que esto falle por cualquier otra razón, NUNCA debe
 * convertirse en un error para quien está creando el pedido. Mismo principio
 * que `tryNotifyStaffNewOrder` de arriba.
 *
 * `orders.ts::createOrder` es el único caller, en la MISMA transacción de sistema
 * (`withAppSession({userId:null})`, `public.ts`/`llm-turn-handler.ts`) que ya insertó
 * el pedido -- mismo hueco y mismo arreglo que `tryNotifyStaffNewOrder`: sin
 * SAVEPOINT, un error real dentro de `notifyCustomerOrderConfirmationEmailCore`
 * (`enqueue_messaging_outbox`, migrations/007) aborta la transacción y el pedido ya
 * creado se pierde con un 500 honesto por rollback (`AbortedTransactionCommitError`,
 * PR #158) en vez de confirmar el pedido. `repo.runWithRowSavepoint` aísla el
 * intento igual que en las otras dos variantes de este archivo.
 */
export async function tryNotifyCustomerOrderConfirmationEmail(repo: RestaurantesRepository, order: Order): Promise<void> {
  try {
    await repo.runWithRowSavepoint(() => notifyCustomerOrderConfirmationEmailCore(repo, order));
  } catch (err) {
    console.error("order-notifications: best-effort customer order confirmation email enqueue failed:", err);
  }
}
