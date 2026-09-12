// Puerto de Google Calendar — port de
// citas-reservaciones/supabase/functions/_shared/google-calendar-port.ts (Deno) a
// Node/TS, sobre `fetch` global (Node 18+, sin la librería `googleapis`) — mismas
// llamadas HTTP que esa librería hace por debajo. Dos implementaciones, mismo patrón
// dual que el resto del repo (RealXxxPort + FakeXxxPort de restaurantes/hoteles):
//
//  - RealGoogleCalendarPort: REST real contra Google, con refresh de access token
//    automático y cacheado en memoria del proceso (30s de margen), nunca por cron
//    separado (ver diseño Fase 3 §4 paso 5).
//  - FakeGoogleCalendarPort: captura en memoria, sin red — para tests deterministas.
//
// Fase 3 §7: watch channels (`startWatch`/`stopWatch`) quedan FUERA de este puerto a
// propósito (opción A del diseño) — el origen los tiene, pero sin receptor de
// webhook nunca se consumen; construir la mitad de esa función aquí sería la misma
// deuda que el origen ya dejó, solo que nueva. Este puerto solo cubre lo que Fase 3
// de verdad usa: crear/actualizar/borrar evento.
//
// IMPORTANTE: RealGoogleCalendarPort es código real de producción, no un stub — pero
// necesita credenciales OAuth reales (GOOGLE_CLIENT_ID/SECRET de plataforma + un
// refresh_token por proveedor, resuelto vía Supabase Vault) que no existen en este
// entorno de desarrollo. El contrato + los dos adaptadores + la prueba de contrato
// contra el adaptador falso sí están completos; la conexión real contra la API de
// Google queda pendiente de credenciales — ver README.md y diseño §4/§9.

export interface CreateEventInput {
  readonly calendarId: string;
  readonly summary: string;
  readonly description: string;
  /** ISO 8601 con offset o "Z". */
  readonly startTime: string;
  readonly endTime: string;
  readonly timeZone: string;
  readonly signal?: AbortSignal;
}

export interface UpdateEventInput {
  readonly calendarId: string;
  readonly eventId: string;
  readonly summary?: string;
  readonly description?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly timeZone: string;
  readonly signal?: AbortSignal;
}

export interface DeleteEventInput {
  readonly calendarId: string;
  readonly eventId: string;
  readonly signal?: AbortSignal;
}

export interface CalendarEventResult {
  readonly eventId: string;
  readonly htmlLink: string | null;
}

/**
 * El contrato completo que necesita el motor de sincronización (calendar-sync.ts).
 * Nunca importa Real/FakeGoogleCalendarPort directamente — así un caller de
 * producción y una prueba local corren exactamente el mismo código de
 * orquestación. Deliberadamente SIN ningún método de lectura (`getEvent`) — ver
 * diseño Fase 3 §6: el flujo de datos es unidireccional (software -> Google), nunca
 * al revés, y esa garantía es estructural (el puerto físicamente no abre ese
 * camino), no solo disciplina.
 */
export interface GoogleCalendarPort {
  createEvent(input: CreateEventInput): Promise<CalendarEventResult>;
  updateEvent(input: UpdateEventInput): Promise<CalendarEventResult>;
  deleteEvent(input: DeleteEventInput): Promise<void>;
}

/** Un evento remoto que ya no existe (borrado a mano en Google, etc.) no es un fallo
 * de sincronización. */
export class CalendarEventNotFoundError extends Error {}

export class GoogleCalendarApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** `invalid_grant` es la única respuesta de Google que significa "este refresh token
 * ya no sirve y no va a empezar a servir con un reintento" (el profesional revocó
 * el acceso, o cambió su contraseña con revocación de sesiones) — distinto de un
 * 429/5xx transitorio. Ver diseño Fase 3 §8, riesgo 2. */
export function isInvalidGrantError(err: unknown): boolean {
  return err instanceof GoogleCalendarApiError && /invalid_grant/i.test(err.body);
}

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export interface ExchangeAuthorizationCodeInput {
  readonly code: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signal?: AbortSignal;
}

export interface ExchangeAuthorizationCodeResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn: number;
}

/**
 * Intercambio real `code` -> `{access_token, refresh_token, expires_in}` del paso 3
 * del flujo OAuth (ver diseño Fase 3 §4) — vive aquí (no en la ruta HTTP) porque es
 * la misma familia de llamadas REST a Google que el resto de este archivo, y así
 * queda unit-testeable sin levantar Hono.
 */
export async function exchangeGoogleAuthorizationCode(input: ExchangeAuthorizationCodeInput): Promise<ExchangeAuthorizationCodeResult> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: input.signal,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new GoogleCalendarApiError("No se pudo intercambiar el código de autorización de Google", response.status, body);
  }
  const parsed = JSON.parse(body) as { access_token: string; refresh_token?: string; expires_in: number };
  return { accessToken: parsed.access_token, refreshToken: parsed.refresh_token ?? null, expiresIn: parsed.expires_in };
}

export interface RealGoogleCalendarPortConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Refresh token del proveedor, ya resuelto (ej. desde Supabase Vault). */
  readonly refreshToken: string;
  /** Callback opcional: Google puede emitir un refresh_token nuevo (rotación). */
  readonly onRefreshTokenRotated?: (nextRefreshToken: string) => Promise<void>;
}

/**
 * Implementación real contra la API pública de Google Calendar v3, sobre `fetch`
 * directo en vez de la librería `googleapis` — mismas llamadas HTTP que esa
 * librería hace internamente para events.insert/patch/delete.
 */
export class RealGoogleCalendarPort implements GoogleCalendarPort {
  #config: RealGoogleCalendarPortConfig;
  #accessToken: string | null = null;
  #accessTokenExpiresAt = 0;

  constructor(config: RealGoogleCalendarPortConfig) {
    this.#config = config;
  }

  async #getAccessToken(): Promise<string> {
    // 30s de margen antes de expirar — cacheado en memoria del proceso, refrescado
    // perezosamente en la primera llamada que lo necesite (nunca por cron separado,
    // ver diseño Fase 3 §4 paso 5).
    if (this.#accessToken && Date.now() < this.#accessTokenExpiresAt - 30_000) {
      return this.#accessToken;
    }
    const response = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#config.clientId,
        client_secret: this.#config.clientSecret,
        refresh_token: this.#config.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new GoogleCalendarApiError("No se pudo refrescar el access token de Google", response.status, body);
    }
    const parsed = JSON.parse(body) as { access_token: string; expires_in: number; refresh_token?: string };
    this.#accessToken = parsed.access_token;
    this.#accessTokenExpiresAt = Date.now() + parsed.expires_in * 1000;
    if (parsed.refresh_token && parsed.refresh_token !== this.#config.refreshToken && this.#config.onRefreshTokenRotated) {
      await this.#config.onRefreshTokenRotated(parsed.refresh_token);
    }
    return this.#accessToken;
  }

  async #request(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
    const token = await this.#getAccessToken();
    const response = await fetch(`${CALENDAR_API_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (response.status === 404) {
      throw new CalendarEventNotFoundError(`Google Calendar: ${path} no encontrado`);
    }
    if (!response.ok) {
      const body = await response.text();
      throw new GoogleCalendarApiError(`Google Calendar API error en ${path}`, response.status, body);
    }
    return response;
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEventResult> {
    const response = await this.#request(`/calendars/${encodeURIComponent(input.calendarId)}/events`, {
      method: "POST",
      signal: input.signal,
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.startTime, timeZone: input.timeZone },
        end: { dateTime: input.endTime, timeZone: input.timeZone },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 30 }] },
      }),
    });
    const data = (await response.json()) as { id: string; htmlLink?: string };
    return { eventId: data.id, htmlLink: data.htmlLink ?? null };
  }

  async updateEvent(input: UpdateEventInput): Promise<CalendarEventResult> {
    const patch: Record<string, unknown> = {};
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.description !== undefined) patch.description = input.description;
    if (input.startTime) patch.start = { dateTime: input.startTime, timeZone: input.timeZone };
    if (input.endTime) patch.end = { dateTime: input.endTime, timeZone: input.timeZone };
    const response = await this.#request(`/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`, {
      method: "PATCH",
      signal: input.signal,
      body: JSON.stringify(patch),
    });
    const data = (await response.json()) as { id: string; htmlLink?: string };
    return { eventId: data.id, htmlLink: data.htmlLink ?? null };
  }

  async deleteEvent(input: DeleteEventInput): Promise<void> {
    try {
      await this.#request(`/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`, {
        method: "DELETE",
        signal: input.signal,
      });
    } catch (err) {
      // Ya no existe en Google -> el estado deseado (que no exista) ya se cumple; no
      // es un fallo de sincronización.
      if (err instanceof CalendarEventNotFoundError) return;
      throw err;
    }
  }
}

interface FakeEvent {
  eventId: string;
  calendarId: string;
  summary: string;
  description: string;
  startTime: string;
  endTime: string;
  timeZone: string;
  deleted: boolean;
}

/**
 * Adaptador simulado/capturador: nunca toca la red. Guarda en memoria cada evento
 * creado/actualizado/borrado, para que las pruebas verifiquen QUÉ se le habría
 * pedido a Google sin depender de credenciales reales.
 */
export class FakeGoogleCalendarPort implements GoogleCalendarPort {
  events = new Map<string, FakeEvent>();
  #nextEventId = 1;
  /** Fuerza que la siguiente llamada falle, para probar el camino de error/reintento. */
  failNextCall: Error | null = null;
  /** Historial de llamadas, para aserciones de "se llamó exactamente así" sin
   * acoplarse a la forma interna de `events`. */
  calls: { method: "createEvent" | "updateEvent" | "deleteEvent"; input: CreateEventInput | UpdateEventInput | DeleteEventInput }[] = [];

  #maybeFail() {
    if (this.failNextCall) {
      const err = this.failNextCall;
      this.failNextCall = null;
      throw err;
    }
  }

  async createEvent(input: CreateEventInput): Promise<CalendarEventResult> {
    this.calls.push({ method: "createEvent", input });
    this.#maybeFail();
    const eventId = `fake-event-${this.#nextEventId++}`;
    this.events.set(eventId, {
      eventId,
      calendarId: input.calendarId,
      summary: input.summary,
      description: input.description,
      startTime: input.startTime,
      endTime: input.endTime,
      timeZone: input.timeZone,
      deleted: false,
    });
    return Promise.resolve({ eventId, htmlLink: `https://calendar.google.com/fake/${eventId}` });
  }

  async updateEvent(input: UpdateEventInput): Promise<CalendarEventResult> {
    this.calls.push({ method: "updateEvent", input });
    this.#maybeFail();
    const existing = this.events.get(input.eventId);
    if (!existing || existing.deleted) {
      throw new CalendarEventNotFoundError(`fake event ${input.eventId} no existe`);
    }
    const updated: FakeEvent = {
      ...existing,
      summary: input.summary ?? existing.summary,
      description: input.description ?? existing.description,
      startTime: input.startTime ?? existing.startTime,
      endTime: input.endTime ?? existing.endTime,
    };
    this.events.set(input.eventId, updated);
    return Promise.resolve({ eventId: input.eventId, htmlLink: `https://calendar.google.com/fake/${input.eventId}` });
  }

  async deleteEvent(input: DeleteEventInput): Promise<void> {
    this.calls.push({ method: "deleteEvent", input });
    this.#maybeFail();
    const existing = this.events.get(input.eventId);
    if (existing) existing.deleted = true;
    return Promise.resolve();
  }
}

/**
 * Prueba de contrato: cualquier GoogleCalendarPort (real o falso) debe cumplir este
 * flujo básico. Correrla contra RealGoogleCalendarPort requiere credenciales OAuth
 * reales que no existen en este entorno — ver la nota de "pendiente de
 * credenciales" al inicio del archivo.
 */
export async function assertGoogleCalendarPortContract(port: GoogleCalendarPort, calendarId: string): Promise<void> {
  const created = await port.createEvent({
    calendarId,
    summary: "Prueba de contrato",
    description: "creada por assertGoogleCalendarPortContract",
    startTime: "2026-09-10T15:00:00.000Z",
    endTime: "2026-09-10T15:30:00.000Z",
    timeZone: "America/Mexico_City",
  });
  if (!created.eventId) throw new Error("createEvent no devolvió eventId");

  const updated = await port.updateEvent({
    calendarId,
    eventId: created.eventId,
    summary: "Prueba de contrato (actualizada)",
    timeZone: "America/Mexico_City",
  });
  if (updated.eventId !== created.eventId) {
    throw new Error("updateEvent devolvió un eventId distinto");
  }

  await port.deleteEvent({ calendarId, eventId: created.eventId });
}
