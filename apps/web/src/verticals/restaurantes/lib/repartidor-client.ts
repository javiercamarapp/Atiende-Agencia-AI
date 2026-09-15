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
import type { AuthedFetchContext, SessionExpiredEventDetail } from "../../../lib/authed-fetch.ts";
import { clearSession, persistSession, readPersistedSession } from "../../../lib/auth-client.ts";
import type { LoginSession } from "../../../lib/auth-client.ts";

export { SessionExpiredError };

/** Ronda 13 — hallazgo de auditoría (severidad ALTA, "Repartidor.tsx es el ÚNICO
 * consumidor autenticado de apps/web que no escucha SESSION_EXPIRED_EVENT"): la
 * ronda 12 cerró "withAuthRefresh en repartidor-client.ts" (el wrapper SÍ intenta un
 * refresh ante un 401, ver `fetchJson` arriba), pero cuando ESE refresh también falla
 * `withAuthRefresh` limpia la sesión y dispara `SESSION_EXPIRED_EVENT` en `window` —
 * un evento que hasta esta ronda NADIE escuchaba en Repartidor.tsx (a diferencia de
 * RestaurantesShell.tsx, ver su comentario ~línea 92). El resultado: el repartidor se
 * quedaba viendo el `.message` de `SessionExpiredError` ("Tu sesión expiró...")
 * pintado como error de carga, sin botón ni redirección — el síntoma original del
 * hallazgo que la ronda 12 declaró cerrado.
 *
 * Este predicado es la MISMA condición que ya usa el `useEffect` de
 * RestaurantesShell.tsx (filtrar por `detail.vertical`, para no reaccionar al
 * session-expired de otra vertical abierta en otra pestaña) — extraída aquí como
 * función pura (sin `window`/React) para poder probarla en el entorno "node" de
 * vitest sin renderizar el componente (este repo no trae infraestructura de testing
 * de componentes React — sin jsdom/happy-dom ni @testing-library, ver
 * vitest.config.ts: `environment: "node"` — así que Repartidor.tsx importa y usa
 * exactamente esta función en su listener en vez de duplicar el `!==` inline, y el
 * test de este archivo cubre la lógica real, no una reimplementación paralela). */
export function isSessionExpiredEventForRepartidor(detail: SessionExpiredEventDetail | undefined): boolean {
  return detail?.vertical === "restaurantes";
}

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
