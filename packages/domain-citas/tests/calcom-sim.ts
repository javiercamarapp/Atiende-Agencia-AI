// SIMULADOR — desarrollo/pruebas: un servidor HTTP real (`node:http`, 127.0.0.1,
// puerto aleatorio) que implementa el formato REAL de request/response de la API
// pública de Cal.com v2 (los mismos endpoints que calcom-port.ts consume) — nunca
// representa una conexión productiva, mismo principio que FakeGoogleCalendarPort
// pero a nivel HTTP real: esto prueba el adaptador REAL (RealCalComPort) contra
// requests HTTP reales — headers, rutas, JSON — sin cuenta ni credenciales reales
// de Cal.com. Port de
// citas-reservaciones/supabase/functions/_shared/calcom-sim.ts (Deno.serve) sobre
// `node:http` + la Fetch API global de Node (Request/Response ya son globales en
// Node 22).
//
// Cubre exactamente los 6 endpoints que RealCalComPort usa, validando:
//   - Authorization: Bearer <token> (401 si falta o no coincide con el apiKey
//     configurado en el simulador).
//   - cal-api-version: rechaza con 400 si no viene el valor exacto documentado
//     para ese endpoint.
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface CalComSimBooking {
  id: number;
  uid: string;
  eventTypeId: number;
  start: string;
  end: string;
  status: "accepted" | "cancelled";
  attendeeName: string;
  attendeeEmail?: string;
}

export interface CalComSimEventType {
  id: number;
  slug: string;
  title: string;
  lengthInMinutes: number;
}

export interface CalComSimOptions {
  apiKey: string;
  eventTypes?: CalComSimEventType[];
  /** Huecos libres que devuelve GET /v2/slots — el simulador NO calcula
   * disponibilidad de verdad (eso es lógica de negocio de Cal.com, fuera de
   * alcance de un simulador de contrato); la prueba fija el escenario. */
  freeSlotsByEventType?: Record<number, { start: string; end: string }[]>;
}

const DEFAULT_EVENT_TYPE: CalComSimEventType = { id: 123, slug: "consulta-general", title: "Consulta general", lengthInMinutes: 30 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorEnvelope(message: string): unknown {
  return { status: "error", message };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function toWebRequest(req: IncomingMessage, bodyText: string): Request {
  const url = `http://127.0.0.1${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const method = req.method ?? "GET";
  return new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : bodyText });
}

export class CalComApiSimulator {
  #apiKey: string;
  #eventTypes: CalComSimEventType[];
  #freeSlotsByEventType: Record<number, { start: string; end: string }[]>;
  #bookings = new Map<string, CalComSimBooking>();
  #server: Server | null = null;
  #nextBookingId = 1;
  #requestsReceived: { method: string; path: string }[] = [];

  constructor(options: CalComSimOptions) {
    this.#apiKey = options.apiKey;
    this.#eventTypes = options.eventTypes ?? [DEFAULT_EVENT_TYPE];
    this.#freeSlotsByEventType = options.freeSlotsByEventType ?? {};
  }

  get requestsReceived(): readonly { method: string; path: string }[] {
    return this.#requestsReceived;
  }

  get bookings(): ReadonlyMap<string, CalComSimBooking> {
    return this.#bookings;
  }

  async start(): Promise<{ baseUrl: string }> {
    const server = createServer((req, res) => {
      void (async () => {
        const bodyText = await readBody(req);
        const webRequest = toWebRequest(req, bodyText);
        const webResponse = await this.#handle(webRequest);
        res.statusCode = webResponse.status;
        webResponse.headers.forEach((value, key) => res.setHeader(key, value));
        const responseBody = await webResponse.text();
        res.end(responseBody);
      })();
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${port}/v2` };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server?.close((err) => (err ? reject(err) : resolve()));
    });
  }

  #checkAuth(req: Request): Response | null {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${this.#apiKey}`) return jsonResponse(401, errorEnvelope("Authorization inválida o ausente"));
    return null;
  }

  #checkVersion(req: Request, expected: string): Response | null {
    const version = req.headers.get("cal-api-version");
    if (version !== expected) return jsonResponse(400, errorEnvelope(`cal-api-version inválido: se esperaba "${expected}", vino "${version ?? "(ausente)"}"`));
    return null;
  }

  async #handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.#requestsReceived.push({ method: req.method, path: url.pathname });

    const authError = this.#checkAuth(req);
    if (authError) return authError;

    // GET /v2/event-types
    if (req.method === "GET" && url.pathname === "/v2/event-types") {
      const versionError = this.#checkVersion(req, "2026-06-12");
      if (versionError) return versionError;
      return jsonResponse(200, { status: "success", data: this.#eventTypes });
    }

    // GET /v2/slots
    if (req.method === "GET" && url.pathname === "/v2/slots") {
      const versionError = this.#checkVersion(req, "2024-09-04");
      if (versionError) return versionError;
      const eventTypeId = Number(url.searchParams.get("eventTypeId"));
      const slots = this.#freeSlotsByEventType[eventTypeId] ?? [];
      const byDate: Record<string, { start: string; end: string }[]> = {};
      for (const slot of slots) {
        const date = slot.start.slice(0, 10);
        (byDate[date] ??= []).push(slot);
      }
      return jsonResponse(200, { status: "success", data: byDate });
    }

    // POST /v2/bookings
    if (req.method === "POST" && url.pathname === "/v2/bookings") {
      const versionError = this.#checkVersion(req, "2026-02-25");
      if (versionError) return versionError;
      const body = (await req.json()) as { start?: string; eventTypeId?: number; attendee?: { name?: string; timeZone?: string; email?: string } };
      if (!body.start || !body.attendee?.name || !body.attendee?.timeZone) {
        return jsonResponse(400, errorEnvelope("start, attendee.name y attendee.timeZone son requeridos"));
      }
      const eventType = this.#eventTypes.find((et) => et.id === body.eventTypeId);
      if (!eventType) return jsonResponse(404, errorEnvelope(`eventTypeId ${body.eventTypeId} no existe`));
      const id = this.#nextBookingId++;
      const uid = `sim-booking-${id}`;
      const start = new Date(body.start);
      const end = new Date(start.getTime() + eventType.lengthInMinutes * 60_000);
      const booking: CalComSimBooking = { id, uid, eventTypeId: eventType.id, start: start.toISOString(), end: end.toISOString(), status: "accepted", attendeeName: body.attendee.name, attendeeEmail: body.attendee.email };
      this.#bookings.set(uid, booking);
      return jsonResponse(201, { status: "success", data: { id: booking.id, uid: booking.uid, title: `${eventType.title} entre ${booking.attendeeName} y el organizador`, status: booking.status, start: booking.start, end: booking.end } });
    }

    const bookingMatch = /^\/v2\/bookings\/([^/]+)(?:\/(reschedule|cancel))?$/.exec(url.pathname);
    if (bookingMatch) {
      const [, uid, action] = bookingMatch;
      const versionError = this.#checkVersion(req, "2026-02-25");
      if (versionError) return versionError;
      const booking = this.#bookings.get(uid!);
      if (!booking) return jsonResponse(404, errorEnvelope(`booking ${uid} no encontrado`));

      if (req.method === "GET" && !action) {
        return jsonResponse(200, { status: "success", data: { id: booking.id, uid: booking.uid, status: booking.status, start: booking.start, end: booking.end } });
      }

      if (req.method === "POST" && action === "reschedule") {
        const body = (await req.json()) as { start?: string };
        if (!body.start) return jsonResponse(400, errorEnvelope("start es requerido"));
        const eventType = this.#eventTypes.find((et) => et.id === booking.eventTypeId)!;
        const start = new Date(body.start);
        const end = new Date(start.getTime() + eventType.lengthInMinutes * 60_000);
        booking.start = start.toISOString();
        booking.end = end.toISOString();
        return jsonResponse(201, { status: "success", data: { id: booking.id, uid: booking.uid, status: booking.status, start: booking.start, end: booking.end } });
      }

      if (req.method === "POST" && action === "cancel") {
        booking.status = "cancelled";
        return jsonResponse(200, { status: "success", data: { id: booking.id, uid: booking.uid, status: booking.status, start: booking.start, end: booking.end } });
      }
    }

    return jsonResponse(404, errorEnvelope(`ruta no simulada: ${req.method} ${url.pathname}`));
  }
}
