// Lógica de datos de reputación/CRM (Fase 11/13, REQ-CRM-002/003) — consume
// apps/api/src/routes/verticals/hoteles/reputacion.ts. Captura MANUAL (encuesta
// propia del staff, o una reseña pública copiada/pegada) -- este panel NUNCA se
// conecta a Google/Booking/TripAdvisor (sin credenciales reales en este repo, ver
// comentario de cabecera de reputacion.ts).
import { fetchJson, sendJson } from "./admin-client.ts";

export type GuestReviewSource = "google" | "booking" | "tripadvisor" | "expedia" | "encuesta_propia" | "otro";
export type GuestReviewStayState = "en_estancia" | "post_estancia" | "desconocido";
export type GuestReviewSentiment = "muy_negativo" | "negativo" | "neutral" | "positivo" | "muy_positivo";
export type GuestReviewActionType = "ticket_mantenimiento" | "mensaje_proactivo" | "compensacion_reglada";
export type GuestReviewActionStatus = "pendiente" | "ejecutada" | "descartada";

export const REVIEW_SOURCE_LABELS: Record<GuestReviewSource, string> = {
  google: "Google",
  booking: "Booking.com",
  tripadvisor: "TripAdvisor",
  expedia: "Expedia",
  encuesta_propia: "Encuesta propia",
  otro: "Otro",
};

export const SENTIMENT_LABELS: Record<GuestReviewSentiment, string> = {
  muy_negativo: "Muy negativo",
  negativo: "Negativo",
  neutral: "Neutral",
  positivo: "Positivo",
  muy_positivo: "Muy positivo",
};

export const ACTION_TYPE_LABELS: Record<GuestReviewActionType, string> = {
  ticket_mantenimiento: "Ticket de mantenimiento",
  mensaje_proactivo: "Mensaje proactivo",
  compensacion_reglada: "Compensación reglada",
};

export const ACTION_STATUS_LABELS: Record<GuestReviewActionStatus, string> = {
  pendiente: "Pendiente",
  ejecutada: "Ejecutada",
  descartada: "Descartada",
};

export interface GuestReviewTopic {
  readonly topic: string;
  readonly esConocido: boolean;
  readonly menciones: number;
  readonly palabrasClave: readonly string[];
}

export interface GuestReview {
  readonly id: string;
  readonly guestId: string | null;
  readonly folioId: string | null;
  readonly source: GuestReviewSource;
  readonly externalId: string | null;
  readonly texto: string;
  readonly idioma: string;
  readonly calificacion: number | null;
  readonly stayState: GuestReviewStayState;
  readonly isPublic: boolean;
  readonly topics: readonly GuestReviewTopic[];
  readonly sentiment: GuestReviewSentiment;
  readonly sentimentScore: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface GuestReviewAction {
  readonly id: string;
  readonly reviewId: string;
  readonly actionType: GuestReviewActionType;
  readonly status: GuestReviewActionStatus;
  readonly ticketId: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface GuestReviewResponse {
  readonly id: string;
  readonly reviewId: string;
  readonly texto: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface GuestReviewDetail {
  readonly resena: GuestReview;
  readonly acciones: readonly GuestReviewAction[];
  readonly respuestas: readonly GuestReviewResponse[];
}

export interface CreateReviewInput {
  readonly texto: string;
  readonly calificacion?: number;
  readonly source: GuestReviewSource;
  readonly stayState?: GuestReviewStayState;
  readonly guestId?: string;
  readonly folioId?: string;
}

export interface TemaAgregado {
  readonly topic: string;
  readonly esConocido: boolean;
  readonly resenas: number;
  readonly resenasNegativas: number;
  readonly pctNegativo: number;
}

export interface IndiceReputacion {
  readonly totalResenas: number;
  readonly promedioSentimiento: number | null;
  readonly promedioCalificacion: number | null;
  readonly distribucionSentimiento: Record<GuestReviewSentiment, number>;
  readonly distribucionSentimientoPct: Record<GuestReviewSentiment, number>;
  readonly puntajeIndice: number | null;
  readonly temasFrecuentes: readonly TemaAgregado[];
  readonly temasCriticos: readonly TemaAgregado[];
}

export async function fetchGuestReviews(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, sentiment?: GuestReviewSentiment): Promise<readonly GuestReview[]> {
  const qs = sentiment ? `?sentiment=${sentiment}` : "";
  return fetchJson<readonly GuestReview[]>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reputacion/resenas${qs}`, token);
}

export async function fetchGuestReviewDetail(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reviewId: string): Promise<GuestReviewDetail> {
  return fetchJson<GuestReviewDetail>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reputacion/resenas/${reviewId}`, token);
}

export async function createGuestReview(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, input: CreateReviewInput): Promise<{ resena: GuestReview; acciones: readonly GuestReviewAction[] }> {
  return sendJson(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reputacion/resenas`, token, "POST", input);
}

export async function respondToGuestReview(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, reviewId: string, texto: string): Promise<GuestReviewResponse> {
  return sendJson<GuestReviewResponse>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reputacion/resenas/${reviewId}/respuestas`, token, "POST", { texto });
}

export async function resolveGuestReviewAction(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  token: string,
  propertyId: string,
  actionId: string,
  status: "ejecutada" | "descartada",
): Promise<GuestReviewAction> {
  return sendJson<GuestReviewAction>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reputacion/acciones/${actionId}/resolver`, token, "POST", { status });
}

export async function fetchReputacionIndice(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<IndiceReputacion> {
  return fetchJson<IndiceReputacion>(fetchImpl, `${apiBaseUrl}/hoteles/${propertyId}/reputacion/indice`, token);
}
