// Fase 8 — cliente HTTP de la superficie real del rol "repartidor" (ver
// apps/api/src/routes/verticals/restaurantes/repartidor-orders.ts). Mismo aislamiento
// que el resto de apps/web: no depende de @atiende/domain-restaurantes, todo lo que
// necesita del contrato de datos vive duplicado aquí (ver orders-client.ts, mismo
// criterio documentado ahí).
export type RepartidorOrderStatus = "pending" | "preparando" | "en_camino" | "entregado" | "cancelado" | "completado" | "problema";

/** Subconjunto de estados que ESTA ruta acepta como destino — puerto literal de
 * `REPARTIDOR_ALLOWED_STATUSES` (order-lifecycle.ts). El servidor SIEMPRE re-valida
 * la transición real contra el estado actual del pedido; esto solo evita ofrecer un
 * botón que el servidor rechazaría. */
export const REPARTIDOR_NEXT_STATUS: Partial<Record<RepartidorOrderStatus, RepartidorOrderStatus>> = {
  preparando: "en_camino",
  en_camino: "entregado",
};

export interface RepartidorOrderItem {
  readonly id: string;
  readonly name: string;
  readonly price: number;
  readonly quantity: number;
}

export interface RepartidorOrder {
  readonly id: string;
  readonly propertyId: string;
  readonly branch: string | null;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly customerAddress: string | null;
  readonly total: number;
  readonly status: RepartidorOrderStatus;
  readonly items: readonly RepartidorOrderItem[];
  readonly notes: string | null;
  readonly paymentMethod: "efectivo" | "tarjeta" | null;
  readonly estimatedDeliveryAt: string | null;
  readonly incidentNote: string | null;
  readonly createdAt: string;
}

export class RepartidorClientError extends Error {}

async function fetchJson<T>(fetchImpl: typeof fetch, url: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new RepartidorClientError(body?.message ?? `No se pudo cargar ${url} (${res.status}).`);
  }
  return (await res.json()) as T;
}

export async function fetchAssignedOrders(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly RepartidorOrder[]> {
  const body = await fetchJson<{ orders: readonly RepartidorOrder[] }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/repartidor/orders`, token);
  return body.orders;
}

export async function updateAssignedOrderStatus(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  orderId: string,
  status: RepartidorOrderStatus,
  incidentNote?: string,
): Promise<RepartidorOrder> {
  const body = await fetchJson<{ order: RepartidorOrder }>(fetchImpl, `${apiBaseUrl}/v1/restaurantes/${propertyId}/repartidor/orders/${orderId}/status`, token, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(incidentNote !== undefined ? { status, incidentNote } : { status }),
  });
  return body.order;
}
