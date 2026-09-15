// Fase 8 — cliente HTTP de la superficie real del rol "repartidor" (ver
// apps/api/src/routes/verticals/restaurantes/repartidor-orders.ts). Mismo aislamiento
// que el resto de apps/web: no depende de @atiende/domain-restaurantes, todo lo que
// necesita del contrato de datos vive duplicado aquí (ver orders-client.ts, mismo
// criterio documentado ahí).
//
// Hallazgo de auditoría (severidad ALTA, "duplicado en TODAS las verticales":
// "Expiración del JWT (15 min) no se maneja: el panel queda muerto sin refresh ni
// redirección"): a diferencia de admin-client.ts (que ya lo corrigió), este archivo
// tenía su propio `fetchJson` privado que llamaba `fetchImpl` directo, sin pasar
// nunca por `withAuthRefresh` (../../../lib/authed-fetch.ts) — un repartidor con
// turno largo (>15 min, ACCESS_TOKEN_TTL_SECONDS=900s) se quedaba con un panel
// muerto en 401 crudo en vez de refrescar en silencio. Mismo `withAuthRefresh` +
// misma sesión ("atiende.restaurantes.session" vía ../../../lib/auth-client.ts) que
// ya usa admin-client.ts — Repartidor.tsx lee esa MISMA sesión con
// `readPersistedSession` (ver su comentario de cabecera), así que reusa exactamente
// el store, no uno nuevo.
import { apiBaseUrlFromRequestUrl, defaultBrowserStorage, withAuthRefresh, SessionExpiredError } from "../../../lib/authed-fetch.ts";
import type { AuthedFetchContext } from "../../../lib/authed-fetch.ts";
import { clearSession, persistSession, readPersistedSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";

export { SessionExpiredError };

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

function defaultAuthCtx(): AuthedFetchContext<LoginSession> {
  const storage = defaultBrowserStorage();
  return {
    vertical: "restaurantes",
    store: {
      read: () => (storage ? readPersistedSession(storage) : null),
      persist: (session) => {
        if (storage) persistSession(storage, session);
      },
      clear: () => {
        if (storage) clearSession(storage);
      },
    },
  };
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  init?: RequestInit,
  authCtx: AuthedFetchContext<LoginSession> = defaultAuthCtx(),
): Promise<T> {
  const res = await withAuthRefresh(fetchImpl, apiBaseUrlFromRequestUrl(url), authCtx, token, (t) =>
    fetchImpl(url, { ...init, headers: { authorization: `Bearer ${t}`, ...(init?.headers ?? {}) } }),
  );
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
