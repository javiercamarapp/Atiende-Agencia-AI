// Lógica de datos de Reservas (Fase 7) — consume
// apps/api/src/routes/verticals/hoteles/reservas.ts (H02, Fase 3). `ReservationStatus`
// y las transiciones válidas se REDECLARAN aquí (en vez de importarse de
// @atiende/domain-hoteles) a propósito: apps/web no depende de ningún paquete
// domain-* (ver package.json — solo react/react-dom/react-router-dom), mismo
// aislamiento que ya mantiene orders-client.ts del vertical restaurantes. Los
// valores deben mantenerse en sync con `RESERVATION_STATUSES`/`VALID_TRANSITIONS` de
// packages/domain-hoteles/src/reservationStateMachine.ts — el servidor SIEMPRE
// re-valida la transición real, esto solo evita ofrecer un botón que el servidor
// rechazaría.
import { fetchJson, sendJson } from "./admin-client.ts";

export type ReservationStatus = "cotizada" | "confirmada" | "check_in" | "en_estancia" | "check_out" | "cerrada" | "cancelada" | "no_show";

export const RESERVATION_STATUS_LABELS: Record<ReservationStatus, string> = {
  cotizada: "Cotizada",
  confirmada: "Confirmada",
  check_in: "Check-in",
  en_estancia: "En estancia",
  check_out: "Check-out",
  cerrada: "Cerrada",
  cancelada: "Cancelada",
  no_show: "No-show",
};

/** Solo las transiciones GENÉRICAS alcanzables desde `PATCH .../transicion` (ver
 * `GENERIC_TRANSITION_TARGETS` en reservas.ts) — `cancelada`/`no_show` tienen rutas
 * dedicadas propias (`/cancelar`, `/procesar-no-show`), nunca la transición genérica.
 * `POST /reservas` de esta fase SIEMPRE crea en `confirmada` (salta `cotizada`), así
 * que en la práctica solo `confirmada -> check_in -> en_estancia -> check_out ->
 * cerrada` es alcanzable desde este panel. */
export const NEXT_GENERIC_STATUS: Partial<Record<ReservationStatus, ReservationStatus>> = {
  confirmada: "check_in",
  check_in: "en_estancia",
  en_estancia: "check_out",
  check_out: "cerrada",
};

/** Mismo criterio que `isCancellable()` del motor real — `cotizada` incluido por
 * fidelidad aunque esta fase nunca crea una reserva en ese estado. */
export function isCancellable(status: ReservationStatus): boolean {
  return status === "cotizada" || status === "confirmada";
}

export interface ReservationSummary {
  readonly id: string;
  readonly propertyId: string;
  readonly roomTypeId: string;
  readonly guestId: string | null;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly estado: ReservationStatus;
  readonly montoTotal: number;
  readonly penalizacionCancelacion: number | null;
  readonly canceladaEn: string | null;
  readonly creadaEn: string;
}

export interface CreateReservationInput {
  readonly roomTypeId: string;
  readonly checkInDate: string;
  readonly checkOutDate: string;
  readonly guestId?: string;
}

export async function fetchReservations(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<readonly ReservationSummary[]> {
  return fetchJson<readonly ReservationSummary[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reservas`, token);
}

export async function fetchReservation(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reservationId: string): Promise<ReservationSummary> {
  return fetchJson<ReservationSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reservas/${reservationId}`, token);
}

export async function createReservation(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  input: CreateReservationInput,
  idempotencyKey: string,
): Promise<ReservationSummary> {
  return sendJson<ReservationSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reservas`, token, "POST", input, idempotencyKey);
}

export async function transitionReservation(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  reservationId: string,
  toStatus: ReservationStatus,
): Promise<ReservationSummary> {
  return sendJson<ReservationSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reservas/${reservationId}/transicion`, token, "PATCH", { toStatus });
}

export async function cancelReservation(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  reservationId: string,
  motivo?: string,
): Promise<ReservationSummary> {
  return sendJson<ReservationSummary>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reservas/${reservationId}/cancelar`, token, "POST", { motivo });
}
