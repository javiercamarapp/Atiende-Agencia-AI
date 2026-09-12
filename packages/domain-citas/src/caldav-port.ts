// Adaptador REAL de CalDAV (RFC 4791) contra el servidor CalDAV real del usuario —
// cubre Apple/iCloud Calendar, Fastmail y Nextcloud (cualquier servidor que
// implemente el protocolo estándar, no una API propietaria). Port de
// citas-reservaciones/supabase/functions/_shared/caldav-port.ts sobre `fetch`
// global de Node — mismo patrón que google-calendar-port.ts/calcom-port.ts de
// este repo. Usa WebDAV real (RFC 4918: PUT/DELETE/PROPFIND/REPORT) con payloads
// iCalendar reales (RFC 5545, vía caldav-ics.ts) y autenticación HTTP Basic
// (RFC 7617) — la que iCloud (con contraseña específica de app), Fastmail y
// Nextcloud (con contraseña de aplicación) exigen en la práctica; Digest
// (RFC 7616) queda fuera de alcance de esta fase porque ninguno de los tres
// servidores objetivo lo requiere hoy — documentado, no una laguna oculta.
//
// LIMITACIÓN REAL Y DELIBERADA — sin descubrimiento de calendar-home-set: RFC
// 4791 define un flujo de descubrimiento vía PROPFIND sobre
// `current-user-principal` (RFC 5397) y luego `calendar-home-set` (RFC 4791 §6.2)
// para encontrar la URL de la colección de calendario a partir solo del servidor
// raíz. Ese flujo es real y muchos clientes completos lo implementan, pero para
// los tres proveedores objetivo de esta fase el usuario obtiene la URL directa de
// su colección de calendario desde la propia configuración de su cuenta (iCloud:
// URL con su ID de cuenta; Nextcloud/Fastmail: URL visible en su panel de
// "compartir calendario por CalDAV") — pedirle esa URL directamente es la vía
// real que usan la mayoría de integraciones no-oficiales contra estos tres
// servicios, y evita construir+probar un flujo de descubrimiento adicional sin
// poder validarlo contra una cuenta real de ninguno de los tres.
// `CalDavPortConfig.calendarCollectionUrl` es esa URL ya resuelta — no se
// descubre aquí (ver la ruta HTTP de conexión en apps/api, que le pide esa URL
// directamente al profesional).
//
// SIN WEBHOOKS (por diseño de la plataforma, no una limitación de este
// adaptador): CalDAV es un protocolo de servidor de archivos sobre WebDAV;
// ninguno de los tres servidores objetivo expone un mecanismo de push estándar
// para "algo cambió". La única forma ESTÁNDAR de detectar cambios es hacer
// polling con el REPORT `sync-collection` (RFC 6578): el servidor recuerda un
// `sync-token` opaco por colección, y una llamada posterior con ese token
// devuelve SOLO los recursos que cambiaron desde entonces. `pollChanges` de abajo
// es ese mecanismo real.
//
// IMPORTANTE — igual que RealGoogleCalendarPort/RealCalComPort: código real de
// producción, no un stub. Necesita credenciales CalDAV reales de un usuario (URL
// de su colección + usuario + contraseña de aplicación) que no existen en este
// entorno. El contrato + este adaptador + el simulador local
// (tests/caldav-sim.ts) + las pruebas contra ese simulador SÍ están completos; la
// conexión contra una cuenta viva de iCloud/Fastmail/Nextcloud queda pendiente de
// credenciales del usuario final.

import { randomUUID } from "node:crypto";
import { buildVEventIcs, parseVEventIcs } from "./caldav-ics.ts";
import { CalendarConflictError, CalendarEventNotFoundError, type AvailabilityQuery, type AvailabilityResult, type CalendarEventResult, type CalendarSyncPort, type CreateCalendarEventInput, type DeleteCalendarEventInput, type UpdateCalendarEventInput } from "./calendar-sync-port.ts";

export class CalDavApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export interface CalDavPortConfig {
  /**
   * URL completa y ya resuelta de la colección de calendario (ver la nota de
   * cabecera sobre por qué no se descubre en esta fase), con `/` final. Ej.:
   *   - iCloud:    https://p01-caldav.icloud.com/1234567/calendars/home/
   *   - Fastmail:  https://caldav.fastmail.com/dav/calendars/user/x@y.com/abc/
   *   - Nextcloud: https://cloud.example.com/remote.php/dav/calendars/usuario/citas/
   */
  readonly calendarCollectionUrl: string;
  readonly username: string;
  /** Contraseña específica de aplicación — nunca la contraseña principal de la
   * cuenta (Apple/Nextcloud/Fastmail lo exigen o lo recomiendan). */
  readonly password: string;
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function icsUtcTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`fecha ISO inválida: "${iso}"`);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Implementación real contra un servidor CalDAV (RFC 4791) sobre `fetch` — sin
 * librería de terceros: el protocolo es WebDAV + XML + iCalendar, texto plano
 * por completo.
 */
export class RealCalDavPort implements CalendarSyncPort {
  readonly platform = "caldav" as const;
  #config: CalDavPortConfig;

  constructor(config: CalDavPortConfig) {
    this.#config = config;
  }

  #resourceUrl(externalCalendarRef: string, uid: string): string {
    // `externalCalendarRef` permite apuntar a una colección distinta de la
    // configurada por defecto (ej. multi-calendario por proveedor); si llega
    // vacío se usa `calendarCollectionUrl` de la config.
    const base = externalCalendarRef || this.#config.calendarCollectionUrl;
    return `${base}${encodeURIComponent(uid)}.ics`;
  }

  #authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: basicAuthHeader(this.#config.username, this.#config.password), ...extra };
  }

  async #handleErrorStatus(response: Response, eventId: string): Promise<never> {
    if (response.status === 404) {
      throw new CalendarEventNotFoundError(`CalDAV: recurso ${eventId} no encontrado`);
    }
    const body = await response.text();
    if (response.status === 412 || response.status === 409) {
      throw new CalendarConflictError(`CalDAV: el recurso ${eventId} cambió en el servidor desde la última lectura (ETag desactualizado)`, eventId);
    }
    throw new CalDavApiError(`CalDAV error en ${eventId}`, response.status, body);
  }

  /** PUT del recurso `.ics` — crea si no existe (`If-None-Match: *`, RFC 4791
   * §5.3.2) o actualiza con concurrencia optimista real si se da `etag`
   * (`If-Match: <etag>`, RFC 7232 §3.1). Sin `etag` en una actualización, el PUT
   * es incondicional (documentado en UpdateCalendarEventInput.etag). */
  async #putEvent(externalCalendarRef: string, uid: string, icsBody: string, opts: { ifNoneMatch?: boolean; ifMatch?: string | null; signal?: AbortSignal }): Promise<{ etag: string | null }> {
    const url = this.#resourceUrl(externalCalendarRef, uid);
    const headers: Record<string, string> = { "Content-Type": "text/calendar; charset=utf-8" };
    if (opts.ifNoneMatch) headers["If-None-Match"] = "*";
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;

    const response = await fetch(url, { method: "PUT", signal: opts.signal, headers: this.#authHeaders(headers), body: icsBody });
    if (!response.ok) await this.#handleErrorStatus(response, uid);
    return { etag: response.headers.get("ETag") };
  }

  async createEvent(input: CreateCalendarEventInput): Promise<CalendarEventResult> {
    const uid = `${randomUUID()}@atiende.ai`;
    const icsBody = buildVEventIcs({ uid, dtstartUtc: input.startTime, dtendUtc: input.endTime, summary: input.summary, description: input.description, attendeeEmail: input.attendeeEmail, attendeeName: input.attendeeName, status: "CONFIRMED" });
    const { etag } = await this.#putEvent(input.externalCalendarRef, uid, icsBody, { ifNoneMatch: true, signal: input.signal });
    return { eventId: uid, htmlLink: null, etag };
  }

  /** CalDAV no tiene un PATCH parcial — RFC 4791 actualiza reemplazando el
   * recurso completo. Por eso se relee el evento actual (GET) para conservar los
   * campos que el caller no mandó a actualizar, y luego se hace PUT del VEVENT
   * completo resultante. */
  async updateEvent(input: UpdateCalendarEventInput): Promise<CalendarEventResult> {
    const current = await this.#getEventRaw(input.externalCalendarRef, input.eventId, input.signal);
    const icsBody = buildVEventIcs({ uid: input.eventId, dtstartUtc: input.startTime ?? current.dtstartUtc, dtendUtc: input.endTime ?? current.dtendUtc, summary: input.summary ?? current.summary ?? "", description: input.description ?? current.description ?? "", status: "CONFIRMED" });
    const { etag } = await this.#putEvent(input.externalCalendarRef, input.eventId, icsBody, { ifMatch: input.etag ?? undefined, signal: input.signal });
    return { eventId: input.eventId, htmlLink: null, etag };
  }

  async deleteEvent(input: DeleteCalendarEventInput): Promise<void> {
    const url = this.#resourceUrl(input.externalCalendarRef, input.eventId);
    const headers: Record<string, string> = {};
    if (input.etag) headers["If-Match"] = input.etag;
    const response = await fetch(url, { method: "DELETE", signal: input.signal, headers: this.#authHeaders(headers) });
    if (response.status === 404) return; // idempotente, mismo principio que Google/Cal.com.
    if (!response.ok) await this.#handleErrorStatus(response, input.eventId);
  }

  async #getEventRaw(externalCalendarRef: string, uid: string, signal?: AbortSignal) {
    const url = this.#resourceUrl(externalCalendarRef, uid);
    const response = await fetch(url, { method: "GET", signal, headers: this.#authHeaders() });
    if (!response.ok) await this.#handleErrorStatus(response, uid);
    const icsText = await response.text();
    return parseVEventIcs(icsText);
  }

  /**
   * REPORT `calendar-query` con filtro `time-range` sobre VEVENT (RFC 4791
   * §7.8.9) — la forma REAL y estándar de preguntarle a un servidor CalDAV "qué
   * eventos existen en este rango", usada para revisar conflictos antes de
   * reservar. Devuelve kind="busy": son VEVENT reales ya existentes en el
   * calendario del proveedor (a diferencia de Cal.com, que devuelve huecos
   * libres ya calculados).
   */
  async listAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const base = query.externalCalendarRef || this.#config.calendarCollectionUrl;
    const start = icsUtcTimestamp(query.startTime);
    const end = icsUtcTimestamp(query.endTime);
    const body = [
      '<?xml version="1.0" encoding="utf-8" ?>',
      '<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">',
      "  <D:prop>",
      "    <D:getetag/>",
      "    <C:calendar-data/>",
      "  </D:prop>",
      "  <C:filter>",
      '    <C:comp-filter name="VCALENDAR">',
      '      <C:comp-filter name="VEVENT">',
      `        <C:time-range start="${start}" end="${end}"/>`,
      "      </C:comp-filter>",
      "    </C:comp-filter>",
      "  </C:filter>",
      "</C:calendar-query>",
    ].join("\n");

    const response = await fetch(base, { method: "REPORT", signal: query.signal, headers: this.#authHeaders({ "Content-Type": "application/xml; charset=utf-8", Depth: "1" }), body });
    if (!response.ok) {
      const responseBody = await response.text();
      throw new CalDavApiError("CalDAV REPORT calendar-query falló", response.status, responseBody);
    }
    const xml = await response.text();
    const intervals = extractCalendarDataBlocks(xml).map((icsBlock) => {
      const parsed = parseVEventIcs(icsBlock);
      return { start: parsed.dtstartUtc, end: parsed.dtendUtc };
    });
    return { kind: "busy", intervals };
  }

  /**
   * REPORT `sync-collection` (RFC 6578) — polling eficiente de cambios: la
   * primera llamada usa `syncToken: null` (trae TODO el estado actual + un
   * sync-token); llamadas siguientes con el token anterior traen SOLO lo que
   * cambió (creado/editado: status 200 con getetag nuevo; borrado: status 404)
   * desde esa llamada. Es la única forma estándar de detectar cambios en CalDAV.
   */
  async pollChanges(syncToken: string | null, signal?: AbortSignal): Promise<{ syncToken: string; changes: { href: string; status: number; etag: string | null }[] }> {
    const body = ['<?xml version="1.0" encoding="utf-8" ?>', '<D:sync-collection xmlns:D="DAV:">', `  <D:sync-token>${syncToken ?? ""}</D:sync-token>`, "  <D:sync-level>1</D:sync-level>", "  <D:prop>", "    <D:getetag/>", "  </D:prop>", "</D:sync-collection>"].join("\n");

    const response = await fetch(this.#config.calendarCollectionUrl, { method: "REPORT", signal, headers: this.#authHeaders({ "Content-Type": "application/xml; charset=utf-8", Depth: "1" }), body });
    if (response.status === 507) {
      // RFC 6578 §3.2: el servidor ya no puede reportar el delta desde ese token
      // (se invalidó/venció) — el caller debe resincronizar completo
      // (syncToken: null) y tratar TODO lo que vuelva como "actual", no como
      // "cambios" incrementales.
      throw new CalDavApiError("CalDAV: sync-token inválido/vencido (507) — hace falta una resincronización completa (syncToken: null)", 507, await response.text());
    }
    if (!response.ok) {
      throw new CalDavApiError("CalDAV REPORT sync-collection falló", response.status, await response.text());
    }
    const xml = await response.text();
    return { syncToken: extractSyncToken(xml) ?? syncToken ?? "", changes: extractSyncChanges(xml) };
  }
}

// ---------------------------------------------------------------------------
// Parseo mínimo de XML de respuesta WebDAV (207 Multi-Status) — regex sobre
// texto, deliberado: el multistatus real es XML simple y plano (sin namespaces
// anidados variables ni atributos que cambien la estructura para los campos que
// este adaptador necesita), y evitar un parser de XML completo reduce la
// superficie de ataque a exactamente los 3 patrones reales que este adaptador
// consume. Nunca evalúa el contenido, solo extrae texto entre tags conocidos.
// ---------------------------------------------------------------------------

function extractCalendarDataBlocks(xml: string): string[] {
  const blocks: string[] = [];
  const re = /<[\w-]*:?calendar-data[^>]*>([\s\S]*?)<\/[\w-]*:?calendar-data>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    blocks.push(decodeXmlEntities(match[1]!.trim()));
  }
  return blocks;
}

function extractSyncToken(xml: string): string | null {
  const match = /<[\w-]*:?sync-token[^>]*>([\s\S]*?)<\/[\w-]*:?sync-token>/.exec(xml);
  return match ? decodeXmlEntities(match[1]!.trim()) : null;
}

function extractSyncChanges(xml: string): { href: string; status: number; etag: string | null }[] {
  const changes: { href: string; status: number; etag: string | null }[] = [];
  const responseRe = /<[\w-]*:?response>([\s\S]*?)<\/[\w-]*:?response>/g;
  let match: RegExpExecArray | null;
  while ((match = responseRe.exec(xml)) !== null) {
    const block = match[1]!;
    const href = /<[\w-]*:?href[^>]*>([\s\S]*?)<\/[\w-]*:?href>/.exec(block)?.[1]?.trim();
    const statusLine = /<[\w-]*:?status[^>]*>([\s\S]*?)<\/[\w-]*:?status>/.exec(block)?.[1]?.trim();
    const etagMatch = /<[\w-]*:?getetag[^>]*>([\s\S]*?)<\/[\w-]*:?getetag>/.exec(block)?.[1]?.trim();
    if (!href) continue;
    const statusCode = statusLine ? Number(/\s(\d{3})\s/.exec(statusLine)?.[1] ?? 200) : 200;
    changes.push({ href: decodeXmlEntities(href), status: statusCode, etag: etagMatch ? decodeXmlEntities(etagMatch) : null });
  }
  return changes;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
