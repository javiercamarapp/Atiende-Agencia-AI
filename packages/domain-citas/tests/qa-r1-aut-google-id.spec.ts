// QA ronda 1 (citas, lente AUTOMATIZACION) -- alta de evento en Google Calendar idempotente (11).
// Un rollback de la transaccion del cron (o un timeout) despues del alta dejaba el evento creado en Google sin su google_event_id
// guardado; la siguiente corrida lo volvia a crear. Ahora el id del evento sale de la cita y un 409 es exito idempotente.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppointment } from "../src/appointments.ts";
import { zonedTimeToUtc } from "../src/availability.ts";
import { syncPendingAppointments } from "../src/calendar-sync.ts";
import { FakeGoogleCalendarPort, RealGoogleCalendarPort, googleEventIdFor } from "../src/google-calendar-port.ts";
import { buildCitasFixture } from "./fixtures.ts";

const MERIDA = "America/Merida";
const INPUT = { calendarId: "primary", summary: "Consulta", description: "x", startTime: "2026-10-21T16:00:00.000Z", endTime: "2026-10-21T16:30:00.000Z", timeZone: MERIDA };

function stubFetch(eventos: (body: Record<string, unknown>) => Response): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("oauth2")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    return eventos(body);
  });
  return bodies;
}

describe("QA-citas-R1-automatizacion-11: alta de evento en Google Calendar no idempotente", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("createEvent manda un id de evento determinista (reintento tras rollback/timeout no duplica el evento)", async () => {
    const bodies = stubFetch(() => new Response(JSON.stringify({ id: "x" }), { status: 200 }));
    const port = new RealGoogleCalendarPort({ clientId: "c", clientSecret: "s", refreshToken: "r" });
    await port.createEvent(INPUT);
    await port.createEvent(INPUT);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.id).toBeDefined();
    expect(bodies[0]?.id).toBe(bodies[1]?.id);
  });

  it("el id cumple el alfabeto base32hex de Google (a-v, 0-9, 5 a 1024 caracteres) y distingue citas", () => {
    const a = googleEventIdFor({ ...INPUT, idempotencyKey: "00000000-0000-0000-0000-00000000000a" });
    const b = googleEventIdFor({ ...INPUT, idempotencyKey: "00000000-0000-0000-0000-00000000000b" });
    expect(a).toMatch(/^[0-9a-v]{26}$/);
    expect(a).not.toBe(b);
    expect(googleEventIdFor({ ...INPUT, idempotencyKey: "00000000-0000-0000-0000-00000000000a" })).toBe(a);
  });

  it("un 409 (el id ya existe: el alta anterior si llego a Google) devuelve el mismo id como exito, sin error", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: 409, message: "The requested identifier already exists." } }), { status: 409 }));
    const port = new RealGoogleCalendarPort({ clientId: "c", clientSecret: "s", refreshToken: "r" });
    const result = await port.createEvent({ ...INPUT, idempotencyKey: "cita-1" });
    expect(result.eventId).toBe(googleEventIdFor({ ...INPUT, idempotencyKey: "cita-1" }));
  });

  it("otros errores de Google (500) siguen propagandose para que el motor reintente con backoff", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    const port = new RealGoogleCalendarPort({ clientId: "c", clientSecret: "s", refreshToken: "r" });
    await expect(port.createEvent(INPUT)).rejects.toMatchObject({ status: 500 });
  });

  it("el motor de sincronizacion manda el id de la cita como clave del alta", async () => {
    const fixture = buildCitasFixture();
    fixture.repo.seedProviderCalendarAccount({ organizationId: fixture.organizationId, providerId: fixture.providerId, googleCalendarId: "primary", refreshToken: "rt" });
    const cita = await createAppointment(fixture.repo, {
      organizationId: fixture.organizationId, providerId: fixture.providerId, serviceId: fixture.serviceId, customerName: "Ana", customerPhone: "9991112233",
      startsAt: zonedTimeToUtc("2026-10-21", "09:00", MERIDA).toISOString(), source: "web",
    });
    const port = new FakeGoogleCalendarPort();
    await syncPendingAppointments(fixture.repo, async () => port);
    const alta = port.calls.find((c) => c.method === "createEvent");
    expect((alta?.input as { idempotencyKey?: string }).idempotencyKey).toBe(cita.id);
  });
});
