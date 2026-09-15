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
import { tryNotifyCustomerOnOrderStatusChange, tryNotifyStaffOrderProblem } from "./order-notifications.ts";
import type { RestaurantesRepository } from "./repository.ts";
import type { Order, OrderStatus } from "./types.ts";

export class OrderStatusTransitionError extends Error {}

export const ORDER_STATUSES: readonly OrderStatus[] = ["pending", "preparando", "en_camino", "entregado", "cancelado", "completado", "problema"];

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
  pending: ["preparando", "cancelado", "problema"],
  preparando: ["en_camino", "cancelado", "problema"],
  en_camino: ["entregado", "problema"],
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
 * puede olvidar el aviso. */
export async function changeOrderStatus(repo: RestaurantesRepository, organizationId: string, order: Order, nextStatus: OrderStatus): Promise<Order> {
  assertValidOrderStatusTransition(order.status, nextStatus);
  const updated = await repo.updateOrderStatus(organizationId, order.id, order.status, nextStatus);
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
    await tryNotifyStaffOrderProblem(repo, updated);
  } else {
    await tryNotifyCustomerOnOrderStatusChange(repo, updated);
  }
  return updated;
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
 */
export async function changeAssignedOrderStatus(
  repo: RestaurantesRepository,
  organizationId: string,
  repartidorId: string,
  order: Order,
  nextStatus: OrderStatus,
  incidentNote: string | null,
): Promise<Order> {
  assertValidRepartidorStatusTransition(order.status, nextStatus);
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
    await tryNotifyStaffOrderProblem(repo, updated);
  } else {
    await tryNotifyCustomerOnOrderStatusChange(repo, updated);
  }
  return updated;
}
