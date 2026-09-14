// Adaptador REAL de Cal.com contra la API pública v2 documentada
// (developer.cal.com / cal.com/docs/api-reference/v2). Port de
// citas-reservaciones/supabase/functions/_shared/calcom-port.ts sobre `fetch`
// global de Node (igual patrón que google-calendar-port.ts de este mismo repo:
// sin SDK, mismas llamadas HTTP que haría `@calcom/api`).
//
// A diferencia de Google (calendarId) o CalDAV (colección WebDAV), Cal.com no
// tiene "calendarios" — se reserva contra un `eventTypeId` (la plantilla de
// duración/disponibilidad configurada por el proveedor en su cuenta de Cal.com).
// `CreateCalendarEventInput.externalCalendarRef` para este adaptador ES el
// eventTypeId (como string, convertido a number).
//
// Endpoints reales usados (cada uno versionado con su propio header
// `cal-api-version` — Cal.com versiona CADA endpoint independientemente, no la
// API completa):
//   - POST   /v2/bookings                    cal-api-version: 2026-02-25
//   - POST   /v2/bookings/{uid}/reschedule   cal-api-version: 2026-02-25
//   - POST   /v2/bookings/{uid}/cancel       cal-api-version: 2026-02-25
//   - GET    /v2/bookings/{uid}              cal-api-version: 2026-02-25
//   - GET    /v2/event-types                 cal-api-version: 2026-06-12
//   - GET    /v2/slots                       cal-api-version: 2024-09-04
//
// IMPORTANTE — igual que RealGoogleCalendarPort: este es código real de
// producción, no un stub. Necesita una API key real de Cal.com (Settings >
// Security, prefijo `cal_`/`cal_live_`) que no existe en este entorno de
// desarrollo. El contrato + este adaptador + el simulador local (tests/calcom-sim.ts)
// + las pruebas contra ese simulador SÍ están completos; la conexión contra una
// cuenta viva de Cal.com queda pendiente de credenciales del usuario final.

import { CalendarEventNotFoundError, type AvailabilityQuery, type AvailabilityResult, type CalendarEventResult, type CalendarSyncPort, type CreateCalendarEventInput, type DeleteCalendarEventInput, type UpdateCalendarEventInput } from "./calendar-sync-port.ts";

export class CalComApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export interface CalComPortConfig {
  /** API key real de Cal.com (`cal_...` modo prueba, `cal_live_...` modo real). */
  readonly apiKey: string;
  /** Overridable solo para pruebas contra el simulador local — en producción
   * siempre es `https://api.cal.com/v2` (el default). */
  readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://api.cal.com/v2";

// Confirmados vía la documentación pública real de Cal.com (OpenAPI embebido en
// cada página de /docs/api-reference/v2/..., campo `operationId` y el parámetro
// `cal-api-version` con `description: "Must be set to X."`).
const CAL_API_VERSION_BOOKINGS = "2026-02-25";
const CAL_API_VERSION_EVENT_TYPES = "2026-06-12";
const CAL_API_VERSION_SLOTS = "2024-09-04";

interface CalComBookingOutput {
  readonly id: number;
  readonly uid: string;
  readonly title: string;
  readonly status: "cancelled" | "accepted" | "rejected" | "pending";
  readonly start: string;
  readonly end: string;
}

interface CalComEnvelope<T> {
  readonly status: "success" | "error";
  readonly data: T;
}

export interface CalComEventType {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly lengthInMinutes: number;
}

/**
 * Implementación real contra la API pública de Cal.com v2 sobre `fetch` (misma
 * razón que RealGoogleCalendarPort: sin dependencias de SDK).
 */
export class RealCalComPort implements CalendarSyncPort {
  readonly platform = "calcom" as const;
  #config: Required<CalComPortConfig>;

  constructor(config: CalComPortConfig) {
    this.#config = { baseUrl: DEFAULT_BASE_URL, ...config };
  }

  async #request(path: string, calApiVersion: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
    const response = await fetch(`${this.#config.baseUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${this.#config.apiKey}`, "cal-api-version": calApiVersion, "Content-Type": "application/json" },
    });
    if (response.status === 404) {
      throw new CalendarEventNotFoundError(`Cal.com: ${path} no encontrado`);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new CalComApiError(`Cal.com API error en ${path}`, response.status, body);
    }
    return response;
  }

  /** El `externalCalendarRef` de Cal.com es el eventTypeId — ver la nota de
   * cabecera. Lanza si no es un número real de event type. */
  #eventTypeIdFrom(externalCalendarRef: string): number {
    const eventTypeId = Number(externalCalendarRef);
    if (!Number.isFinite(eventTypeId)) {
      throw new Error(`RealCalComPort: externalCalendarRef debe ser un eventTypeId numérico, vino "${externalCalendarRef}"`);
    }
    return eventTypeId;
  }

  /**
   * POST /v2/bookings — crea un booking estándar (CreateBookingInput_2024_08_13).
   * `summary`/`description` no son campos directos de la API de Cal.com (el
   * título lo determina el event type + attendee); se guardan en `metadata`, el
   * único campo genuinamente libre del contrato real.
   */
  async createEvent(input: CreateCalendarEventInput): Promise<CalendarEventResult> {
    const eventTypeId = this.#eventTypeIdFrom(input.externalCalendarRef);
    const response = await this.#request("/bookings", CAL_API_VERSION_BOOKINGS, {
      method: "POST",
      signal: input.signal,
      body: JSON.stringify({
        start: input.startTime,
        eventTypeId,
        attendee: { name: input.attendeeName ?? "Cliente", timeZone: input.timeZone, email: input.attendeeEmail, phoneNumber: input.attendeePhone },
        metadata: { summary: input.summary, description: input.description },
      }),
    });
    const parsed = (await response.json()) as CalComEnvelope<CalComBookingOutput>;
    return { eventId: parsed.data.uid, htmlLink: null };
  }

  /**
   * POST /v2/bookings/{uid}/reschedule — Cal.com no tiene un PATCH genérico de
   * booking: reprogramar (mover fecha) es su propio endpoint, y
   * summary/description no son reprogramables después de creado (viven en
   * metadata, que este endpoint no acepta) — documentado, no una omisión.
   */
  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventResult> {
    if (!input.startTime) {
      throw new Error("RealCalComPort.updateEvent: Cal.com solo soporta reprogramar (nueva `startTime`); summary/description no son editables después de creado el booking.");
    }
    const response = await this.#request(`/bookings/${encodeURIComponent(input.eventId)}/reschedule`, CAL_API_VERSION_BOOKINGS, { method: "POST", signal: input.signal, body: JSON.stringify({ start: input.startTime }) });
    const parsed = (await response.json()) as CalComEnvelope<CalComBookingOutput>;
    return { eventId: parsed.data.uid, htmlLink: null };
  }

  /** POST /v2/bookings/{uid}/cancel */
  async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    try {
      await this.#request(`/bookings/${encodeURIComponent(input.eventId)}/cancel`, CAL_API_VERSION_BOOKINGS, { method: "POST", signal: input.signal, body: JSON.stringify({}) });
    } catch (err) {
      // Mismo principio que RealGoogleCalendarPort: un booking que ya no existe
      // -> el estado deseado ya se cumple, no es un fallo de sync.
      if (err instanceof CalendarEventNotFoundError) return;
      throw err;
    }
  }

  /** GET /v2/bookings/{uid} — expuesto además del contrato genérico porque un
   * futuro motor de reconciliación (análogo a calendar-sync.ts) necesita poder
   * releer el estado real de un booking sin pasar por listAvailability. */
  async getBooking(bookingUid: string, signal?: AbortSignal): Promise<CalComBookingOutput> {
    const response = await this.#request(`/bookings/${encodeURIComponent(bookingUid)}`, CAL_API_VERSION_BOOKINGS, { method: "GET", signal });
    const parsed = (await response.json()) as CalComEnvelope<CalComBookingOutput>;
    return parsed.data;
  }

  /** GET /v2/event-types — catálogo real de event types de la cuenta conectada
   * (equivalente a listar "calendarios" en Google). */
  async listEventTypes(signal?: AbortSignal): Promise<CalComEventType[]> {
    const response = await this.#request("/event-types", CAL_API_VERSION_EVENT_TYPES, { method: "GET", signal });
    const parsed = (await response.json()) as CalComEnvelope<CalComEventType[]>;
    return parsed.data;
  }

  /**
   * GET /v2/slots?eventTypeId=...&start=...&end=...&timeZone=...&format=range
   * Cal.com devuelve huecos YA LIBRES (kind="free", ver calendar-sync-port.ts) —
   * ya filtrados contra reglas de disponibilidad, buffers y bookings existentes
   * del lado de Cal.com. `format=range` da {start,end} por slot en vez de solo el
   * string de inicio.
   */
  async listAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const eventTypeId = this.#eventTypeIdFrom(query.externalCalendarRef);
    const params = new URLSearchParams({ eventTypeId: String(eventTypeId), start: query.startTime, end: query.endTime, format: "range" });
    if (query.timeZone) params.set("timeZone", query.timeZone);
    const response = await this.#request(`/slots?${params.toString()}`, CAL_API_VERSION_SLOTS, { method: "GET", signal: query.signal });
    const parsed = (await response.json()) as CalComEnvelope<Record<string, { start: string; end: string }[]>>;
    const intervals = Object.values(parsed.data).flat();
    return { kind: "free", intervals };
  }
}
