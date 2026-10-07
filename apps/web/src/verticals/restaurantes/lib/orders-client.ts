// Lógica de datos de Pedidos en operación + Historial (Fase 5) — mismo endpoint de
// listado para ambas vistas (ver comentario de cabecera de admin-orders.ts), un
// filtro distinto por página. Estados reales de `orders.status`
// (migrations/001_restaurantes_schema.sql) — nunca inventados.
import { fetchJson, sendJson } from "./admin-client.ts";

export type OrderStatus = "pending" | "preparando" | "en_camino" | "entregado" | "cancelado" | "completado" | "problema" | "listo_para_recoger" | "no_recogido" | "programado" | "por_aprobar";

export type OrderCanal = "domicilio" | "recoger";

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Recibido",
  preparando: "Preparando",
  en_camino: "En camino",
  entregado: "Entregado",
  completado: "Completado",
  cancelado: "Cancelado",
  problema: "Incidencia",
  listo_para_recoger: "Listo para recoger",
  no_recogido: "No recogido",
  programado: "Programado",
  por_aprobar: "Por aprobar",
};

/** Próximos estados que SÍ aplican al canal del pedido: un pedido para recoger no sale "en_camino" y los estados
 * de recoger no aplican a domicilio. Canal desconocido (pedido histórico) ofrece todos; el servidor valida igual. */
export function nextStatusesForCanal(status: OrderStatus, canal: OrderCanal | null | undefined): readonly OrderStatus[] {
  return NEXT_STATUSES[status].filter((next) => {
    if (canal === "recoger") return next !== "en_camino";
    if (canal === "domicilio") return next !== "listo_para_recoger" && next !== "no_recogido";
    return true;
  });
}

/** Próximos estados válidos por estado actual — mismo grafo real que
 * `@atiende/domain-restaurantes::order-lifecycle.ts` (duplicado aquí a propósito:
 * apps/web no depende de ningún paquete domain-*, mismo aislamiento que
 * dashboard-client.ts — ver ese archivo). Debe mantenerse en sync manualmente si el
 * dominio cambia la máquina de estados; el servidor SIEMPRE re-valida la transición
 * real, esto solo evita ofrecer un botón que el servidor rechazaría. */
export const NEXT_STATUSES: Record<OrderStatus, readonly OrderStatus[]> = {
  // R-11: un programado espera fuera de cocina; "pending" lo adelanta a cocina, "cancelado" lo descarta.
  programado: ["pending", "cancelado"],
  // Autopiloto: un pedido grande retenido se aprueba o rechaza desde "Por aprobar" (su solicitud), nunca con un cambio de estado manual.
  por_aprobar: [],
  pending: ["preparando", "cancelado", "problema"],
  preparando: ["en_camino", "listo_para_recoger", "cancelado", "problema"],
  en_camino: ["entregado", "problema"],
  // Recoger (PM): el cliente lo recoge ("entregado") o no llega ("no_recogido", que vuelve a cocina).
  listo_para_recoger: ["entregado", "no_recogido", "cancelado", "problema"],
  no_recogido: ["preparando", "cancelado"],
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
  /** PM PR-3 (migración 031): canal, propina y hora prometida de recogida. `null` en pedidos anteriores o
   * contra una base sin migrar; ausentes en respuestas de versiones viejas del API. */
  readonly canal?: OrderCanal | null;
  readonly propina?: number | null;
  readonly horaRecogida?: string | null;
  /** R-11 (migración 034): hora para la que se programó el pedido (ISO UTC) y cuándo se promovió a cocina.
   * `null`/ausentes en pedidos normales, anteriores o contra una base sin migrar. */
  readonly programadoPara?: string | null;
  readonly promovidoAt?: string | null;
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

export async function updateOrderStatus(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  orderId: string,
  status: OrderStatus,
  /** `false` = no avisar por WhatsApp al cliente (aviso opcional de "listo para recoger"). Omitido = comportamiento de siempre. */
  options: {
    readonly notifyCustomer?: boolean;
    /** Nota de la incidencia (solo con `status: "problema"`). */
    readonly incidentNote?: string;
    /** Obligatorio al cancelar: motivo de la lista cerrada (`MOTIVOS_CANCELACION`). */
    readonly motivo?: string;
  } = {},
): Promise<OrderSummary> {
  const payload = {
    status,
    ...(options.notifyCustomer === false ? { notifyCustomer: false } : {}),
    ...(options.incidentNote !== undefined ? { incidentNote: options.incidentNote } : {}),
    ...(options.motivo ? { motivo: options.motivo } : {}),
  };
  const body = await sendJson<{ order: OrderSummary }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/orders/${orderId}/status`, token, "PATCH", payload);
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

/** Repartidor sugerido por el servidor (carga y tiempo sin recibir pedido). Solo lectura: asignar sigue siendo `assignRepartidor`. */
export interface RepartidorSugerido {
  readonly repartidorId: string;
  readonly nombre: string;
  /** Pedidos `en_camino` que ya lleva. */
  readonly enCamino: number;
}

/** `GET .../admin/repartidor-sugerido?orderIds=`: sugerencias por id de pedido (a domicilio, en `preparando`, sin repartidor). Los pedidos sin sugerencia no aparecen. */
export async function fetchRepartidorSugerido(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, orderIds: readonly string[]): Promise<Readonly<Record<string, RepartidorSugerido>>> {
  if (orderIds.length === 0) return {};
  const body = await fetchJson<{ sugerencias: Record<string, RepartidorSugerido> }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/repartidor-sugerido?orderIds=${orderIds.map(encodeURIComponent).join(",")}`, token);
  return body.sugerencias ?? {};
}

/** Respuesta de la pestaña Programados. `disponible:false` = la base aún no tiene la migración 034. */
export interface ScheduledOrdersPage {
  readonly disponible: boolean;
  readonly orders: readonly OrderSummary[];
  /** Ids promovidos a cocina por ESTA consulta (la promoción corre al consultar, sin cron). */
  readonly promovidos: readonly string[];
  readonly serverNow: string;
}

export async function fetchScheduledOrders(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, filter: { readonly branchId?: string; readonly limit?: number } = {}): Promise<ScheduledOrdersPage> {
  const params = new URLSearchParams();
  if (filter.branchId) params.set("branchId", filter.branchId);
  if (filter.limit) params.set("limit", String(filter.limit));
  const qs = params.toString();
  return fetchJson<ScheduledOrdersPage>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/admin/scheduled-orders${qs ? `?${qs}` : ""}`, token);
}
