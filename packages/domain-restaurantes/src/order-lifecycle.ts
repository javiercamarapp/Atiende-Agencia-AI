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
 * domain-restaurantes, la ruta HTTP solo autoriza y traduce errores a HTTP. */
export async function changeOrderStatus(
  repo: { updateOrderStatus(organizationId: string, orderId: string, status: OrderStatus): Promise<Order | null> },
  organizationId: string,
  order: Order,
  nextStatus: OrderStatus,
): Promise<Order> {
  assertValidOrderStatusTransition(order.status, nextStatus);
  const updated = await repo.updateOrderStatus(organizationId, order.id, nextStatus);
  if (!updated) throw new OrderStatusTransitionError("El pedido ya no existe.");
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
 */
export async function changeAssignedOrderStatus(
  repo: { updateAssignedOrderStatus(organizationId: string, repartidorId: string, orderId: string, status: OrderStatus, incidentNote: string | null): Promise<Order | null> },
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
  const updated = await repo.updateAssignedOrderStatus(organizationId, repartidorId, order.id, nextStatus, nextStatus === "problema" ? incidentNote!.trim() : null);
  if (!updated) throw new OrderStatusTransitionError("El pedido ya no existe o ya no está asignado a este repartidor.");
  return updated;
}
