// Lógica de datos de Pedidos en operación + Historial (Fase 5) — mismo endpoint de
// listado para ambas vistas (ver comentario de cabecera de admin-orders.ts), un
// filtro distinto por página. Estados reales de `orders.status`
// (migrations/001_restaurantes_schema.sql) — nunca inventados.
import { fetchJson, sendJson } from "./admin-client.ts";

export type OrderStatus = "pending" | "preparando" | "en_camino" | "entregado" | "cancelado" | "completado" | "problema";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Recibido",
  preparando: "Preparando",
  en_camino: "En camino",
  entregado: "Entregado",
  completado: "Completado",
  cancelado: "Cancelado",
  problema: "Incidencia",
};

/** Próximos estados válidos por estado actual — mismo grafo real que
 * `@atiende/domain-restaurantes::order-lifecycle.ts` (duplicado aquí a propósito:
 * apps/web no depende de ningún paquete domain-*, mismo aislamiento que
 * dashboard-client.ts — ver ese archivo). Debe mantenerse en sync manualmente si el
 * dominio cambia la máquina de estados; el servidor SIEMPRE re-valida la transición
 * real, esto solo evita ofrecer un botón que el servidor rechazaría. */
export const NEXT_STATUSES: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["preparando", "cancelado", "problema"],
  preparando: ["en_camino", "cancelado", "problema"],
  en_camino: ["entregado", "problema"],
  entregado: ["completado", "problema"],
  problema: ["preparando", "cancelado"],
  cancelado: [],
  completado: [],
};

export interface OrderItem {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
  readonly tortilla?: string;
}

export interface OrderSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly branch: string | null;
  readonly customerId: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string | null;
  readonly total: number;
  readonly status: OrderStatus;
  readonly items: readonly OrderItem[];
  readonly source: "web" | "voice" | "whatsapp" | "admin";
  readonly notes: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly createdAt: string;
  /** Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
   * no tiene UI"): estos 3 campos ya los devolvía `serializeOrder` de admin-orders.ts
   * desde la Fase 8 (`assign-repartidor`), pero este tipo nunca los declaraba —
   * Pedidos.tsx no podía mostrar ni actuar sobre el dispatch de un repartidor. */
  readonly assignedRepartidorId: string | null;
  readonly estimatedDeliveryAt: string | null;
  readonly incidentNote: string | null;
}

export interface OrderListFilter {
  readonly branchId?: string;
  readonly status?: OrderStatus;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OrderListPage {
  readonly orders: readonly OrderSummary[];
  readonly nextCursor: string | null;
}

export async function fetchOrders(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filter: OrderListFilter = {}): Promise<OrderListPage> {
  const params = new URLSearchParams();
  if (filter.branchId) params.set("branchId", filter.branchId);
  if (filter.status) params.set("status", filter.status);
  if (filter.dateFrom) params.set("dateFrom", filter.dateFrom);
  if (filter.dateTo) params.set("dateTo", filter.dateTo);
  if (filter.limit) params.set("limit", String(filter.limit));
  if (filter.cursor) params.set("cursor", filter.cursor);
  const qs = params.toString();
  return fetchJson<OrderListPage>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/orders${qs ? `?${qs}` : ""}`, token);
}

export async function updateOrderStatus(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderId: string, status: OrderStatus): Promise<OrderSummary> {
  const body = await sendJson<{ order: OrderSummary }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/orders/${orderId}/status`, token, "PATCH", { status });
  return body.order;
}

// Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido no
// tiene UI"): cliente real de `PATCH .../admin/orders/:orderId/assign-repartidor`
// (Fase 8, admin-orders.ts) — el ÚNICO endpoint que despacha un pedido. Sin esta
// función, ninguna página de apps/web podía siquiera llamarlo.
export async function assignRepartidor(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  orderId: string,
  repartidorId: string,
  estimatedDeliveryAt?: string | null,
): Promise<OrderSummary> {
  const payload: { repartidorId: string; estimatedDeliveryAt?: string | null } = { repartidorId };
  if (estimatedDeliveryAt !== undefined) payload.estimatedDeliveryAt = estimatedDeliveryAt;
  const body = await sendJson<{ order: OrderSummary }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/orders/${orderId}/assign-repartidor`, token, "PATCH", payload);
  return body.order;
}
