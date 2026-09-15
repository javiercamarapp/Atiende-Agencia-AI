// CalendarSyncPort: el contrato GENÉRICO de sincronización de calendario del que
// GoogleCalendarPort (google-calendar-port.ts, Fase 3, ya mergeado y sin tocar) es
// una implementación entre varias — junto con Cal.com (calcom-port.ts) y CalDAV
// (caldav-port.ts, que cubre Apple/iCloud, Fastmail, Nextcloud y cualquier otro
// servidor CalDAV real, RFC 4791). Port de
// citas-reservaciones/supabase/functions/_shared/calendar-sync-port.ts.
//
// Este archivo NO reconstruye el motor de Google — google-calendar-port.ts y
// calendar-sync.ts siguen exactamente igual, probados y en producción. Lo que
// hace este archivo es generalizar el contrato hacia arriba: GoogleCalendarSyncAdapter
// envuelve un GoogleCalendarPort real o falso ya existente y lo expone bajo la
// forma genérica, para que código nuevo (multi-plataforma) pueda tratar Google/
// Cal.com/CalDAV de forma uniforme sin que el motor de Google deje de ser el que
// ya está probado.
//
// Tres plataformas, tres modelos de dominio distintos — el contrato generaliza
// solo lo que de verdad es común a las tres:
//   - Google Calendar: calendario + evento, calendarId es un ID de recurso.
//   - Cal.com: booking + event type — no existe "calendarId"; el equivalente es
//     el eventTypeId (la plantilla de disponibilidad/duración contra la que se
//     reserva).
//   - CalDAV (RFC 4791): colección de calendario (una carpeta WebDAV) + recursos
//     .ics individuales (RFC 5545). El "calendarId" es el href de esa colección.
// `externalCalendarRef` documenta esa ambigüedad deliberada en vez de fingir que
// las tres plataformas comparten un mismo concepto de calendario.

import { CalendarEventNotFoundError } from "./google-calendar-port.ts";
import type { GoogleCalendarPort } from "./google-calendar-port.ts";

// Reexport: UN solo tipo de "no encontrado" para que código que orquesta múltiples
// plataformas pueda hacer `catch (err) { if (err instanceof CalendarEventNotFoundError) ... }`
// sin importar de cuál adaptador vino.
export { CalendarEventNotFoundError };

export type CalendarPlatform = "google" | "calcom" | "caldav";

export interface CreateCalendarEventInput {
  /** Ver la nota de arriba: significado distinto por plataforma. */
  readonly externalCalendarRef: string;
  readonly summary: string;
  readonly description: string;
  /** ISO 8601 con offset o "Z". */
  readonly startTime: string;
  readonly endTime: string;
  readonly timeZone: string;
  readonly attendeeEmail?: string;
  readonly attendeeName?: string;
  readonly attendeePhone?: string;
  readonly signal?: AbortSignal;
}

export interface UpdateCalendarEventInput {
  readonly externalCalendarRef: string;
  readonly eventId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly timeZone: string;
  /**
   * ETag de la última lectura conocida del recurso. Solo CalDAV lo usa de verdad
   * (concurrencia optimista real vía `If-Match`, RFC 4791 §5.3.4 + RFC 7232) —
   * Google y Cal.com lo ignoran silenciosamente porque sus APIs no exponen ese
   * mecanismo. Queda en el contrato genérico (opcional) en vez de solo en CalDAV
   * para que el caller no necesite saber qué plataforma es para decidir si vale la
   * pena mandarlo.
   */
  readonly etag?: string | null;
  readonly signal?: AbortSignal;
}

export interface DeleteCalendarEventInput {
  readonly externalCalendarRef: string;
  readonly eventId: string;
  readonly etag?: string | null;
  readonly signal?: AbortSignal;
}

export interface CalendarEventResult {
  readonly eventId: string;
  readonly htmlLink: string | null;
  /** Solo CalDAV lo llena con el ETag real de la respuesta del servidor. */
  readonly etag?: string | null;
}

export interface AvailabilityInterval {
  /** ISO 8601 UTC ("Z"). */
  readonly start: string;
  readonly end: string;
}

export interface AvailabilityQuery {
  readonly externalCalendarRef: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timeZone?: string;
  readonly signal?: AbortSignal;
}

/**
 * Las plataformas exponen "disponibilidad" con semántica INVERSA entre sí, y
 * fingir que son lo mismo sería el tipo de generalización falsa que este archivo
 * evita:
 *   - "busy": intervalos OCUPADOS (CalDAV vía calendar-query con time-range sobre
 *     VEVENT reales) — un slot es reservable si NO se solapa con ninguno.
 *   - "free": intervalos YA LIBRES, calculados por la plataforma contra sus
 *     propias reglas de disponibilidad (Cal.com vía GET /v2/slots, que considera
 *     horario de trabajo, buffers y bookings existentes) — un slot es reservable
 *     solo si cae DENTRO de alguno completo.
 */
export type AvailabilityKind = "busy" | "free";

export interface AvailabilityResult {
  readonly kind: AvailabilityKind;
  readonly intervals: readonly AvailabilityInterval[];
}

/**
 * El contrato completo que necesita cualquier motor de sincronización de citas
 * multi-plataforma. Análogo a GoogleCalendarPort pero sin los métodos de watch/
 * webhook — esos NO generalizan: Cal.com tiene su propio modelo de webhooks (no
 * cubierto en esta fase) y CalDAV/Apple no soporta push en absoluto (ver
 * caldav-port.ts, que expone en su lugar `pollChanges` vía sync-collection,
 * RFC 6578 — una capacidad real de esa plataforma que no tiene sentido forzar en
 * el contrato genérico).
 */
export interface CalendarSyncPort {
  readonly platform: CalendarPlatform;
  createEvent(input: CreateCalendarEventInput): Promise<CalendarEventResult>;
  updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventResult>;
  deleteEvent(input: DeleteCalendarEventInput): Promise<void>;
  /** Puede lanzar CalendarCapabilityUnsupportedError — ver GoogleCalendarSyncAdapter
   * más abajo para el caso real de esta fase. */
  listAvailability(query: AvailabilityQuery): Promise<AvailabilityResult>;
}

/** Una plataforma no soporta una operación del contrato genérico — nunca se
 * confunde con un error transitorio de red: el caller no debe reintentar. */
export class CalendarCapabilityUnsupportedError extends Error {}

/** Concurrencia optimista real: el recurso cambió en el servidor entre la lectura
 * y la escritura (CalDAV `412 Precondition Failed` sobre `If-Match`/`If-None-Match`,
 * RFC 7232 §2.3/§4.2). El caller debe releer el recurso (nuevo ETag) antes de
 * reintentar — reintentar con el mismo ETag viejo repetiría el mismo 412
 * indefinidamente. */
export class CalendarConflictError extends Error {
  constructor(
    message: string,
    readonly eventId: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Helper puro de conflictos — la generalización real de "manejo de conflictos"
// que pide el encargo: funciona igual sin importar de qué plataforma vino el
// AvailabilityResult, respetando su `kind`.
// ---------------------------------------------------------------------------

function toEpochMs(iso: string): number {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) throw new Error(`fecha ISO inválida: "${iso}"`);
  return ms;
}

/** `true` si [aStart,aEnd) se solapa con [bStart,bEnd) — comparación de intervalos
 * semiabiertos estándar (un evento que termina exactamente cuando otro empieza NO
 * se considera solapado). */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return toEpochMs(aStart) < toEpochMs(bEnd) && toEpochMs(bStart) < toEpochMs(aEnd);
}

/**
 * Generalización real de "manejo de conflictos": dado un AvailabilityResult (de
 * CUALQUIER adaptador) y un rango propuesto, decide si ese rango es reservable —
 * respetando que "busy" y "free" son opuestos semánticos, no una normalización con
 * pérdida hacia un solo formato.
 */
export function isRangeBookable(availability: AvailabilityResult, proposedStart: string, proposedEnd: string): boolean {
  if (availability.kind === "busy") {
    return !availability.intervals.some((busy) => rangesOverlap(busy.start, busy.end, proposedStart, proposedEnd));
  }
  // kind === "free": reservable solo si el rango propuesto cae COMPLETO dentro de
  // un único hueco libre (reservar a caballo entre dos huecos libres separados no
  // es válido: hay algo ocupado en medio).
  return availability.intervals.some((free) => toEpochMs(proposedStart) >= toEpochMs(free.start) && toEpochMs(proposedEnd) <= toEpochMs(free.end));
}

// ---------------------------------------------------------------------------
// GoogleCalendarSyncAdapter — Google como "una implementación entre varias"
// ---------------------------------------------------------------------------

/**
 * Envuelve un GoogleCalendarPort ya existente (Real o Fake, sin importar cuál —
 * este archivo nunca los importa directamente) y lo expone bajo el contrato
 * genérico. createEvent/updateEvent/deleteEvent delegan 1:1 en el motor real ya
 * probado (google-calendar-port.ts, calendar-sync.ts) — cero lógica nueva, cero
 * riesgo de regresión.
 *
 * `attendeeEmail`/`attendeeName`/`attendeePhone` del contrato genérico se
 * DESCARTAN aquí a propósito — `GoogleCalendarPort.CreateEventInput` (Fase 3,
 * fusion) no modela asistentes todavía (a diferencia del origen); agregar ese
 * campo sería tocar el motor de Google ya probado, fuera de alcance de esta fase.
 *
 * `listAvailability` NO delega: esta base de datos (ver README de Fase 1, "El
 * software es la fuente de verdad") deliberadamente nunca consulta disponibilidad
 * libre/ocupada en Google Calendar — el motor de citas calcula disponibilidad
 * contra `availability_rules` + `appointments` (availability.ts) y el
 * `EXCLUDE USING gist` de Postgres es quien de verdad previene el doble-booking.
 * Añadir aquí una llamada real a Google (freeBusy.query) sería una capacidad
 * nueva de producción no pedida en este encargo — se deja explícito como no
 * soportada en vez de fingir una paridad con Cal.com/CalDAV que el resto del
 * sistema no usaría.
 */
export class GoogleCalendarSyncAdapter implements CalendarSyncPort {
  readonly platform = "google" as const;
  #port: GoogleCalendarPort;

  constructor(port: GoogleCalendarPort) {
    this.#port = port;
  }

  async createEvent(input: CreateCalendarEventInput): Promise<CalendarEventResult> {
    const result = await this.#port.createEvent({
      calendarId: input.externalCalendarRef,
      summary: input.summary,
      description: input.description,
      startTime: input.startTime,
      endTime: input.endTime,
      timeZone: input.timeZone,
      signal: input.signal,
    });
    return { eventId: result.eventId, htmlLink: result.htmlLink };
  }

  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventResult> {
    const result = await this.#port.updateEvent({
      calendarId: input.externalCalendarRef,
      eventId: input.eventId,
      summary: input.summary,
      description: input.description,
      startTime: input.startTime,
      endTime: input.endTime,
      timeZone: input.timeZone,
      signal: input.signal,
    });
    return { eventId: result.eventId, htmlLink: result.htmlLink };
  }

  async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    await this.#port.deleteEvent({ calendarId: input.externalCalendarRef, eventId: input.eventId, signal: input.signal });
  }

  async listAvailability(_query: AvailabilityQuery): Promise<AvailabilityResult> {
    throw new CalendarCapabilityUnsupportedError(
      "GoogleCalendarSyncAdapter.listAvailability: por diseño, este motor nunca consulta disponibilidad en Google Calendar — la base de datos propia (availability_rules + appointments) es la única fuente de verdad.",
    );
  }
}

// ---------------------------------------------------------------------------
// Prueba de contrato — análoga a assertGoogleCalendarPortContract pero para el
// contrato genérico. listAvailability se prueba aparte (assertAvailabilityContract)
// porque su "kind" varía por plataforma y no todas las plataformas la soportan
// (Google, ver arriba).
// ---------------------------------------------------------------------------

export async function assertCalendarSyncPortContract(port: CalendarSyncPort, externalCalendarRef: string): Promise<void> {
  const created = await port.createEvent({
    externalCalendarRef,
    summary: "Prueba de contrato genérico",
    description: "creada por assertCalendarSyncPortContract",
    startTime: "2026-09-10T15:00:00.000Z",
    endTime: "2026-09-10T15:30:00.000Z",
    timeZone: "America/Mexico_City",
    attendeeEmail: "cliente@example.com",
    attendeeName: "Cliente de prueba",
  });
  if (!created.eventId) throw new Error("createEvent no devolvió eventId");

  // `startTime` va SIEMPRE en la actualización de prueba (no solo `summary`): es
  // el único campo que las tres plataformas garantizan poder editar — Cal.com en
  // particular solo soporta reprogramar (POST .../reschedule), nunca editar
  // summary/description de un booking ya creado (ver calcom-port.ts). Un contrato
  // genérico que asumiera "editar solo el título" como caso universal estaría
  // generalizando falso.
  const updated = await port.updateEvent({
    externalCalendarRef,
    eventId: created.eventId,
    summary: "Prueba de contrato genérico (actualizada)",
    startTime: "2026-09-10T16:00:00.000Z",
    endTime: "2026-09-10T16:30:00.000Z",
    timeZone: "America/Mexico_City",
    etag: created.etag ?? undefined,
  });
  if (updated.eventId !== created.eventId) {
    throw new Error("updateEvent devolvió un eventId distinto");
  }

  await port.deleteEvent({ externalCalendarRef, eventId: created.eventId, etag: updated.etag ?? undefined });
}

/** Prueba de contrato para `listAvailability` — solo para adaptadores que sí la
 * soportan (Cal.com, CalDAV). `expectedKind` obliga al caller a declarar qué
 * semántica espera, para que un cambio accidental de "free" a "busy" (o
 * viceversa) en un adaptador real rompa la prueba en vez de pasar en silencio. */
export async function assertAvailabilityContract(port: CalendarSyncPort, externalCalendarRef: string, expectedKind: AvailabilityKind): Promise<AvailabilityResult> {
  const result = await port.listAvailability({ externalCalendarRef, startTime: "2026-09-10T00:00:00.000Z", endTime: "2026-09-11T00:00:00.000Z", timeZone: "America/Mexico_City" });
  if (result.kind !== expectedKind) {
    throw new Error(`listAvailability: se esperaba kind="${expectedKind}", vino "${result.kind}"`);
  }
  if (!Array.isArray(result.intervals)) {
    throw new Error("listAvailability: intervals no es un arreglo");
  }
  return result;
}
