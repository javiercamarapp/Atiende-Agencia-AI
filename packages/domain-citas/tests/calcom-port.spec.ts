// Pruebas del adaptador REAL de Cal.com (RealCalComPort) contra el simulador
// local (calcom-sim.ts) — nunca contra api.cal.com real. Verifica el formato REAL
// de request/response documentado (headers cal-api-version exactos, rutas
// /v2/bookings, /v2/bookings/{uid}/reschedule|cancel, /v2/event-types,
// /v2/slots), no un contrato inventado.
//
// La conexión contra una cuenta viva de Cal.com queda pendiente de credenciales
// del usuario final — ver la nota de cabecera en src/calcom-port.ts.
import { describe, expect, it } from "vitest";
import { assertAvailabilityContract, assertCalendarSyncPortContract } from "../src/calendar-sync-port.ts";
import { CalendarEventNotFoundError } from "../src/google-calendar-port.ts";
import { RealCalComPort } from "../src/calcom-port.ts";
import { CalComApiSimulator } from "./calcom-sim.ts";

const API_KEY = "cal_test_1234567890";
const EVENT_TYPE_ID = 555;

async function withSimulator(fn: (port: RealCalComPort, sim: CalComApiSimulator) => Promise<void>): Promise<void> {
  const sim = new CalComApiSimulator({
    apiKey: API_KEY,
    eventTypes: [{ id: EVENT_TYPE_ID, slug: "consulta-general", title: "Consulta general", lengthInMinutes: 30 }],
    freeSlotsByEventType: {
      [EVENT_TYPE_ID]: [
        { start: "2026-09-10T15:00:00.000Z", end: "2026-09-10T15:30:00.000Z" },
        { start: "2026-09-10T15:30:00.000Z", end: "2026-09-10T16:00:00.000Z" },
      ],
    },
  });
  const { baseUrl } = await sim.start();
  try {
    const port = new RealCalComPort({ apiKey: API_KEY, baseUrl });
    await fn(port, sim);
  } finally {
    await sim.stop();
  }
}

describe("RealCalComPort", () => {
  it("cumple el contrato genérico completo contra el simulador", async () => {
    await withSimulator(async (port) => {
      await assertCalendarSyncPortContract(port, String(EVENT_TYPE_ID));
    });
  });

  it("createEvent: manda el request REAL (start/eventTypeId/attendee) y Cal.com responde con uid", async () => {
    await withSimulator(async (port, sim) => {
      const result = await port.createEvent({
        externalCalendarRef: String(EVENT_TYPE_ID),
        summary: "Consulta general - Juan Pérez",
        description: "Tel: 5512345678",
        startTime: "2026-09-10T15:00:00.000Z",
        endTime: "2026-09-10T15:30:00.000Z",
        timeZone: "America/Mexico_City",
        attendeeName: "Juan Pérez",
        attendeeEmail: "juan@example.com",
      });
      expect(result.eventId.startsWith("sim-booking-")).toBe(true);
      const stored = sim.bookings.get(result.eventId);
      expect(stored).toBeDefined();
      expect(stored!.eventTypeId).toBe(EVENT_TYPE_ID);
      expect(stored!.attendeeName).toBe("Juan Pérez");
      expect(stored!.attendeeEmail).toBe("juan@example.com");
      expect(stored!.status).toBe("accepted");
    });
  });

  it("createEvent: eventTypeId inexistente responde 404 -> CalendarEventNotFoundError", async () => {
    await withSimulator(async (port) => {
      await expect(
        port.createEvent({
          externalCalendarRef: "999999",
          summary: "x",
          description: "x",
          startTime: "2026-09-10T15:00:00.000Z",
          endTime: "2026-09-10T15:30:00.000Z",
          timeZone: "America/Mexico_City",
          attendeeName: "x",
        }),
      ).rejects.toBeInstanceOf(CalendarEventNotFoundError);
    });
  });

  it("updateEvent: reprograma vía POST /bookings/{uid}/reschedule real", async () => {
    await withSimulator(async (port, sim) => {
      const created = await port.createEvent({
        externalCalendarRef: String(EVENT_TYPE_ID),
        summary: "x",
        description: "x",
        startTime: "2026-09-10T15:00:00.000Z",
        endTime: "2026-09-10T15:30:00.000Z",
        timeZone: "America/Mexico_City",
        attendeeName: "Juan Pérez",
      });
      const updated = await port.updateEvent({ externalCalendarRef: String(EVENT_TYPE_ID), eventId: created.eventId, startTime: "2026-09-11T16:00:00.000Z", timeZone: "America/Mexico_City" });
      expect(updated.eventId).toBe(created.eventId);
      const stored = sim.bookings.get(created.eventId);
      expect(stored?.start).toBe("2026-09-11T16:00:00.000Z");
    });
  });

  it("updateEvent: sin startTime lanza (Cal.com no soporta editar summary/description tras crear)", async () => {
    await withSimulator(async (port) => {
      await expect(port.updateEvent({ externalCalendarRef: String(EVENT_TYPE_ID), eventId: "cualquiera", summary: "nuevo título", timeZone: "America/Mexico_City" })).rejects.toThrow();
    });
  });

  it("deleteEvent: cancela vía POST /bookings/{uid}/cancel real", async () => {
    await withSimulator(async (port, sim) => {
      const created = await port.createEvent({ externalCalendarRef: String(EVENT_TYPE_ID), summary: "x", description: "x", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City", attendeeName: "Juan Pérez" });
      await port.deleteEvent({ externalCalendarRef: String(EVENT_TYPE_ID), eventId: created.eventId });
      expect(sim.bookings.get(created.eventId)?.status).toBe("cancelled");
    });
  });

  it("deleteEvent: cancelar un booking que ya no existe no lanza (idempotente)", async () => {
    await withSimulator(async (port) => {
      await port.deleteEvent({ externalCalendarRef: String(EVENT_TYPE_ID), eventId: "nunca-existió" });
    });
  });

  it("listAvailability: GET /v2/slots real -> kind=free con los huecos exactos del escenario", async () => {
    await withSimulator(async (port) => {
      const result = await assertAvailabilityContract(port, String(EVENT_TYPE_ID), "free");
      expect(result.intervals).toEqual([
        { start: "2026-09-10T15:00:00.000Z", end: "2026-09-10T15:30:00.000Z" },
        { start: "2026-09-10T15:30:00.000Z", end: "2026-09-10T16:00:00.000Z" },
      ]);
    });
  });

  it("listEventTypes: GET /v2/event-types real -> catálogo configurado en el simulador", async () => {
    await withSimulator(async (port) => {
      const eventTypes = await port.listEventTypes();
      expect(eventTypes).toHaveLength(1);
      expect(eventTypes[0]?.id).toBe(EVENT_TYPE_ID);
      expect(eventTypes[0]?.slug).toBe("consulta-general");
    });
  });

  it("getBooking: GET /v2/bookings/{uid} real", async () => {
    await withSimulator(async (port) => {
      const created = await port.createEvent({ externalCalendarRef: String(EVENT_TYPE_ID), summary: "x", description: "x", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City", attendeeName: "Juan Pérez" });
      const booking = await port.getBooking(created.eventId);
      expect(booking.uid).toBe(created.eventId);
      expect(booking.status).toBe("accepted");
    });
  });

  it("el simulador exige el cal-api-version REAL exacto por endpoint (no cualquier valor)", async () => {
    const sim = new CalComApiSimulator({ apiKey: API_KEY });
    const { baseUrl } = await sim.start();
    try {
      const response = await fetch(`${baseUrl}/event-types`, { headers: { Authorization: `Bearer ${API_KEY}`, "cal-api-version": "2020-01-01" } });
      expect(response.status).toBe(400);
      await response.text();
    } finally {
      await sim.stop();
    }
  });

  it("el simulador exige Authorization: Bearer <apiKey> real", async () => {
    const sim = new CalComApiSimulator({ apiKey: API_KEY });
    const { baseUrl } = await sim.start();
    try {
      const response = await fetch(`${baseUrl}/event-types`, { headers: { "cal-api-version": "2026-06-12" } });
      expect(response.status).toBe(401);
      await response.text();
    } finally {
      await sim.stop();
    }
  });
});
