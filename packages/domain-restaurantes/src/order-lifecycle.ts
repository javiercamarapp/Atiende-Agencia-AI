// Fase 5 back-office CORE — máquina de estados real de un pedido en operación (ver
// diseño §1.3). El origen (PedidosSection.tsx/PedidoDetalleSection.tsx) nunca
// modela esto como una máquina de estados explícita: transiciona con updates ad-hoc
// (`status: 'en_camino'`, `status: 'entregado'`, `status: 'problema'`, `status:
// 'cancelado'`) directo desde la UI, siempre hacia adelante salvo la recuperación de
// una incidencia. Este archivo formaliza esas mismas transiciones reales (nunca
// inventa un estado nuevo — usa exactamente los 7 valores de `orders.status` que ya
// define migrations/001) para que la ruta HTTP pueda rechazar un salto inválido
// (p.ej. "pending" -> "entregado" saltándose preparación) ANTES de tocar la base de
// datos, en vez de dejar que cualquier string llegue crudo a un `update`.
import type { TenantDbSession } from "@atiende/core-tenancy";
import { tryNotifyCustomerOnOrderStatusChange, tryNotifyStaffOrderProblem } from "./order-notifications.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Order, OrderPickupInfo, OrderStatus } from "./types.ts";

export class OrderStatusTransitionError extends Error {}

export const ORDER_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema", "listo_para_recoger", "no_recogido", "programado", "por_aprobar"];

/** Estados exclusivos del canal recoger (migracion 031). */
export const PICKUP_ONLY_STATUSES: readonly OrderStatus[] = ["listo_para_recoger", "no_recogido"];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * Transiciones válidas — port del flujo real observado en PedidosSection.tsx del
 * origen: pending -> preparando -> en_camino -> entregado -> completado (avance
 * normal), cancelado disponible en cualquier punto antes de entregar (mismo botón
 * "Cancelar pedido" del origen, disponible en la lista de pendientes/en curso), y
 * "problema" (incidencia) disponible desde cualquier estado activo, con
 * recuperación real hacia preparando o cancelado (nunca queda varado). "cancelado"
 * y "completado" son terminales: ningún caso de negocio real hoy reabre un pedido
 * ya cerrado.
 */
const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // R-11: un pedido programado espera fuera de cocina; pasa a `pending` (promocion automatica o a mano para
  // adelantarlo) o se cancela. Nunca salta directo a preparacion/entrega.
  programado: ["pending", "cancelado"],
  // Autopiloto: un pedido grande retenido espera UNA decision humana. Solo se aprueba (pending, o programado si es para mas tarde) o se
  // rechaza (cancelado) por la solicitud de aprobacion (`resolverSolicitudAprobacion`): `changeOrderStatus` rechaza el atajo manual.
  por_aprobar: ["pending", "programado", "cancelado"],
  pending: ["preparando", "cancelado", "problema"],
  // Un pedido para recoger sale de cocina como `listo_para_recoger` (no `en_camino`): la regla de canal
  // se aplica en `changeOrderStatus`, que conoce el canal del pedido.
  preparando: ["en_camino", "listo_para_recoger", "cancelado", "problema"],
  en_camino: ["entregado", "problema"],
  // Recoger (PM): listo en mostrador -> el cliente lo recoge (`entregado`) o no llega (`no_recogido`).
  listo_para_recoger: ["entregado", "no_recogido", "cancelado", "problema"],
  // No recogido: vuelve a cocina (`preparando`, p. ej. el cliente llega tarde y hay que rehacerlo o
  // recalentarlo) o se cancela.
  no_recogido: ["preparando", "cancelado"],
  entregado: ["completado", "problema"],
  problema: ["preparando", "cancelado"],
  cancelado: [],
  completado: [],
};

export function nextValidStatuses(from: OrderStatus): readonly OrderStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/** Lanza OrderStatusTransitionError si `from -> to` no es una transición real
 * permitida — nunca dice "no hay pedidos" ni relanza como error genérico, el
 * mensaje siempre nombra los dos estados para que el staff entienda qué rechazó el
 * sistema. */
export function assertValidOrderStatusTransition(from: OrderStatus, to: OrderStatus): void {
  if (from === to) {
    throw new OrderStatusTransitionError(`El pedido ya está en estado "${to}".`);
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new OrderStatusTransitionError(`No se puede cambiar un pedido de "${from}" a "${to}".`);
  }
}

/** Wrapper de conveniencia usado por la ruta HTTP: valida la transición real contra
 * el pedido YA resuelto (el caller ya verificó organización/alcance de sucursal
 * antes de llegar aquí) y persiste vía el repositorio — mismo patrón que
 * `createOrder`/`quoteOrder` de orders.ts: la lógica de negocio vive en
 * domain-restaurantes, la ruta HTTP solo autoriza y traduce errores a HTTP.
 *
 * Fase 9 — ÚNICO choke point real de toda transición de estado disparada por
 * MANAGER_ROLES (ver admin-orders.ts `PATCH .../orders/:orderId/status`): dispara
 * aquí mismo (best-effort, nunca revierte la transición) el WhatsApp real al
 * cliente cuando el nuevo estado es uno de los notificados (ver
 * order-notifications.ts) — así ninguna otra ruta que llegue a agregarse aquí
 * puede olvidar el aviso.
 *
 * `db` (opcional) es el MISMO `TenantDbSession` de `c.get("db")` en el caller
 * (admin-orders.ts) — se reenvía a `tryNotify*` para que puedan envolver su
 * best-effort en SAVEPOINT cuando comparten transacción con el UPDATE de arriba
 * (Blocker A, revisión de PR #169: sin esto, un fallo real dentro del best-effort
 * en sesión de staff abortaba la transacción completa y este MISMO UPDATE se
 * perdía pese a haber "persistido" antes en la misma transacción). */
export async function changeOrderStatus(
  repo: RestaurantesRepository,
  organizationId: string,
  order: Order,
  nextStatus: OrderStatus,
  db?: TenantDbSession,
  options: {
    /** `false` = no avisar por WhatsApp al cliente (aviso opcional de "listo para recoger"). */
    readonly avisarCliente?: boolean;
    /** Nota de la incidencia: solo aplica (y se guarda) con `nextStatus === "problema"`, tambien tras la entrega. */
    readonly incidentNote?: string | null;
  } = {},
): Promise<Order> {
  if (order.status === "por_aprobar") {
    // Mover el pedido a mano dejaria la solicitud de aprobacion pendiente y sin bitacora de la decision.
    throw new OrderStatusTransitionError('Un pedido "por_aprobar" se aprueba o se rechaza desde la pestaña "Por aprobar", no con un cambio de estado.');
  }
  assertValidOrderStatusTransition(order.status, nextStatus);
  const incidentNote = options.incidentNote === undefined || options.incidentNote === null ? null : options.incidentNote.trim();
  if (incidentNote !== null) {
    if (nextStatus !== "problema") throw new OrderStatusTransitionError('incidentNote solo aplica cuando el nuevo estado es "problema".');
    if (incidentNote.length < 1 || incidentNote.length > 2000) throw new OrderStatusTransitionError("La nota de la incidencia debe tener entre 1 y 2000 caracteres.");
  }
  await assertCanalAllowsStatus(repo, organizationId, order, nextStatus);
  const updated = await repo.updateOrderStatus(organizationId, order.id, order.status, nextStatus, incidentNote);
  if (!updated) {
    // Fix hallazgo auditoría (rubro 3, "máquina de estados de pedidos sin guarda
    // TOCTOU") — `order.status` (con el que se validó arriba) puede haber quedado
    // obsoleto entre el `findOrderById` que hizo la ruta HTTP y este UPDATE (otra
    // request concurrente ya lo cambió primero). `updateOrderStatus` ahora exige
    // `status = order.status` en su propio WHERE — si vuelve null, se distingue
    // "ya no existe" de "cambió de estado mientras tanto" SOLO aquí, en el camino
    // de error (nunca se paga ese `findOrderById` extra en el camino feliz).
    const current = await repo.findOrderById(organizationId, order.id);
    if (!current) throw new OrderStatusTransitionError("El pedido ya no existe.");
    throw new OrderStatusTransitionError(
      `El pedido cambió de estado mientras se procesaba esta solicitud (ahora está "${current.status}", se esperaba "${order.status}"). Actualiza la vista e intenta de nuevo.`,
    );
  }
  if (updated.status === "problema") {
    await tryNotifyStaffOrderProblem(repo, updated, db);
  } else if (options.avisarCliente !== false) {
    await tryNotifyCustomerOnOrderStatusChange(repo, updated, db);
  }
  return updated;
}

/** Marca historica de canal en las notas (antes de la columna `orders.canal`). */
const NOTA_CANAL_RECOGER = /Canal: recoger en sucursal\./;

/** ¿Es un pedido para recoger? Usa la columna `canal` (migracion 031) y, si el pedido es anterior o la
 * base no esta migrada, la marca historica de las notas. `null` = no se puede saber. */
export function esPedidoParaRecoger(order: Pick<Order, "notes">, info: Pick<OrderPickupInfo, "canal"> | null): boolean | null {
  if (info?.canal) return info.canal === "recoger";
  if (order.notes && NOTA_CANAL_RECOGER.test(order.notes)) return true;
  return null;
}

/** Los estados de recoger solo valen para pedidos de canal recoger; un pedido para recoger no sale `en_camino`.
 * Si el canal no se puede determinar (pedido historico sin marca) no se bloquea. */
async function assertCanalAllowsStatus(repo: RestaurantesRepository, organizationId: string, order: Order, nextStatus: OrderStatus): Promise<void> {
  const esEstadoRecoger = (PICKUP_ONLY_STATUSES as readonly string[]).includes(nextStatus);
  if (!esEstadoRecoger && nextStatus !== "en_camino") return;
  const [info] = await repo.listOrderPickupInfo(organizationId, [order.id]);
  const recoger = esPedidoParaRecoger(order, info ?? null);
  if (esEstadoRecoger && recoger === false) {
    throw new OrderStatusTransitionError(`El estado "${nextStatus}" solo aplica a pedidos para recoger en sucursal; este pedido es a domicilio.`);
  }
  if (nextStatus === "en_camino" && recoger === true) {
    throw new OrderStatusTransitionError('Un pedido para recoger no sale "en_camino": márquelo "listo_para_recoger" cuando esté listo en mostrador.');
  }
}

/** Estados en los que ya no tiene sentido despachar a un repartidor (cerrados o exclusivos de recoger). */
const NO_DESPACHABLES: readonly OrderStatus[] = ["cancelado", "completado", "entregado", "no_recogido", "listo_para_recoger"];

/** QA-restaurantes-R1-features-05a/05b: un pedido cerrado o para recoger en sucursal no se asigna a repartidor. */
export async function assertOrderCanBeDispatched(repo: RestaurantesRepository, organizationId: string, order: Order): Promise<void> {
  if (NO_DESPACHABLES.includes(order.status)) {
    throw new OrderStatusTransitionError(`No se puede asignar repartidor a un pedido en estado "${order.status}".`);
  }
  const [info] = await repo.listOrderPickupInfo(organizationId, [order.id]);
  if (esPedidoParaRecoger(order, info ?? null) === true) {
    throw new OrderStatusTransitionError("Un pedido para recoger en sucursal no se asigna a un repartidor.");
  }
}

// ---- Fase 8 — transiciones que un REPARTIDOR (nunca MANAGER_ROLES) puede disparar
// sobre SU PROPIO pedido asignado (ver roles.ts, repartidor-orders.ts). ----

/**
 * Subconjunto de estados que un repartidor puede fijar como destino — port literal
 * de los `p_status` que acepta `update_assigned_order_status()` del origen
 * (migrations/008_repartidor_order_assignment.sql): "en_camino" (recibió el pedido y
 * salió), "entregado" (cerró la entrega), "problema" (incidencia en cualquier punto
 * del trayecto). Un repartidor JAMÁS pone "preparando"/"cancelado"/"completado" —
 * esos son movimientos de gestión (MANAGER_ROLES vía admin-orders.ts).
 */
export const REPARTIDOR_ALLOWED_STATUSES: readonly OrderStatus[] = ["en_camino", "entregado", "problema"];

/**
 * DESVIACIÓN DELIBERADA respecto al origen, documentada aquí a propósito (mismo
 * criterio que el XML de nómina de despachos: nunca fabricar una regla no
 * verificada): el RPC courier del origen (`update_assigned_order_status`) permite
 * "en_camino" tanto desde "pending" como desde "preparando" directo. La máquina de
 * estados YA UNIFICADA de esta rama (`ALLOWED_TRANSITIONS` arriba, Fase 5) solo
 * permite "preparando" -> "en_camino" para CUALQUIER caller, staff incluido — no se
 * reintroduce aquí un atajo exclusivo para repartidor que ni el propio staff tiene;
 * un pedido debe pasar por "preparando" antes de salir a reparto, sin excepción por
 * rol. En la práctica esto solo importa si algún día un repartidor puede marcar
 * "recibido" antes de que cocina lo prepare — no es el flujo real observado.
 */
export function assertValidRepartidorStatusTransition(from: OrderStatus, to: OrderStatus): void {
  if (!REPARTIDOR_ALLOWED_STATUSES.includes(to)) {
    throw new OrderStatusTransitionError(`Un repartidor no puede cambiar un pedido a "${to}".`);
  }
  assertValidOrderStatusTransition(from, to);
}

/**
 * Wrapper de conveniencia para la ruta HTTP de repartidor — mismo patrón que
 * `changeOrderStatus` de arriba, pero acotado a la transición + al repositorio
 * `updateAssignedOrderStatus` (que además re-verifica `assigned_repartidor_id` en el
 * WHERE, defensa en profundidad). `incidentNote` se exige si y solo si `nextStatus`
 * es "problema" — mismo constraint exacto que el CHECK del RPC del origen.
 *
 * Fase 9 — el OTRO choke point real de transición de estado (ver comentario de
 * `changeOrderStatus`): un repartidor SÍ puede mover un pedido a en_camino/
 * entregado/problema, así que el aviso real al cliente (en_camino/entregado) y la
 * incidencia al staff (problema) viven aquí también, best-effort igual.
 *
 * `db` (opcional) — mismo criterio y misma razón que `changeOrderStatus` de arriba
 * (Blocker A, revisión de PR #169): se reenvía a `tryNotify*` para el SAVEPOINT.
 */
export async function changeAssignedOrderStatus(
  repo: RestaurantesRepository,
  organizationId: string,
  repartidorId: string,
  order: Order,
  nextStatus: OrderStatus,
  incidentNote: string | null,
  db?: TenantDbSession,
): Promise<Order> {
  assertValidRepartidorStatusTransition(order.status, nextStatus);
  // QA-restaurantes-R1-features-05c: misma regla de canal que la ruta del gerente (un pedido para recoger no sale en_camino).
  await assertCanalAllowsStatus(repo, organizationId, order, nextStatus);
  if (nextStatus === "problema") {
    if (!incidentNote || incidentNote.trim().length < 1 || incidentNote.trim().length > 2000) {
      throw new OrderStatusTransitionError('Para reportar una incidencia ("problema") debes escribir qué pasó (1-2000 caracteres).');
    }
  } else if (incidentNote !== null) {
    throw new OrderStatusTransitionError('incidentNote solo aplica cuando el nuevo estado es "problema".');
  }
  const updated = await repo.updateAssignedOrderStatus(
    organizationId,
    repartidorId,
    order.id,
    order.status,
    nextStatus,
    nextStatus === "problema" ? incidentNote!.trim() : null,
  );
  if (!updated) {
    // Mismo fix TOCTOU que `changeOrderStatus` de arriba.
    const current = await repo.findAssignedOrderById(organizationId, repartidorId, order.id);
    if (!current) throw new OrderStatusTransitionError("El pedido ya no existe o ya no está asignado a este repartidor.");
    throw new OrderStatusTransitionError(
      `El pedido cambió de estado mientras se procesaba esta solicitud (ahora está "${current.status}", se esperaba "${order.status}"). Actualiza la vista e intenta de nuevo.`,
    );
  }
  if (updated.status === "problema") {
    await tryNotifyStaffOrderProblem(repo, updated, db);
  } else {
    await tryNotifyCustomerOnOrderStatusChange(repo, updated, db);
  }
  return updated;
}
