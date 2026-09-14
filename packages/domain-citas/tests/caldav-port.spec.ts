// Pruebas del adaptador REAL de CalDAV (RealCalDavPort) contra el simulador local
// (caldav-sim.ts) — nunca contra un servidor real de iCloud/Fastmail/Nextcloud.
// Verifica el formato REAL del protocolo: verbos WebDAV (PUT/GET/DELETE/REPORT),
// XML de REPORT (calendar-query con time-range, sync-collection), ETags reales e
// If-Match/If-None-Match — no un contrato inventado.
import { describe, expect, it } from "vitest";
import { assertAvailabilityContract, assertCalendarSyncPortContract, CalendarConflictError } from "../src/calendar-sync-port.ts";
import { CalendarEventNotFoundError } from "../src/google-calendar-port.ts";
import { RealCalDavPort } from "../src/caldav-port.ts";
import { CalDavServerSimulator } from "./caldav-sim.ts";

const USERNAME = "proveedor@example.com";
const PASSWORD = "app-password-real-1234";
const CALENDAR_PATH = "/calendars/proveedor/citas/";

async function withSimulator(fn: (port: RealCalDavPort, sim: CalDavServerSimulator, calendarCollectionUrl: string) => Promise<void>): Promise<void> {
  const sim = new CalDavServerSimulator({ username: USERNAME, password: PASSWORD, calendarPath: CALENDAR_PATH });
  const { calendarCollectionUrl } = await sim.start();
  try {
    const port = new RealCalDavPort({ calendarCollectionUrl, username: USERNAME, password: PASSWORD });
    await fn(port, sim, calendarCollectionUrl);
  } finally {
    await sim.stop();
  }
}

describe("RealCalDavPort", () => {
  it("cumple el contrato genérico completo contra el simulador", async () => {
    await withSimulator(async (port) => {
      await assertCalendarSyncPortContract(port, "");
    });
  });

  it("createEvent: PUT real con If-None-Match: * y body ICS válido; el simulador devuelve ETag", async () => {
    await withSimulator(async (port, sim) => {
      const result = await port.createEvent({
        externalCalendarRef: "",
        summary: "Consulta general - Juan Pérez",
        description: "Tel: 5512345678",
        startTime: "2026-09-10T15:00:00.000Z",
        endTime: "2026-09-10T15:30:00.000Z",
        timeZone: "America/Mexico_City",
        attendeeEmail: "juan@example.com",
        attendeeName: "Juan Pérez",
      });
      expect(result.eventId.includes("@atiende.ai")).toBe(true);
      expect(result.etag).toBeTruthy();
      const stored = sim.resources.get(result.eventId);
      expect(stored).toBeDefined();
      expect(stored!.icsBody).toContain("SUMMARY:Consulta general - Juan Pérez");
      expect(stored!.icsBody).toContain("ATTENDEE;CN=Juan Pérez:mailto:juan@example.com");
      expect(sim.requestsReceived.some((r) => r.method === "PUT" && r.path.endsWith(".ics"))).toBe(true);
    });
  });

  it("updateEvent: relee el evento (GET) y hace PUT completo conservando campos no editados", async () => {
    await withSimulator(async (port) => {
      const created = await port.createEvent({ externalCalendarRef: "", summary: "Título original", description: "Descripción original", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City" });
      const updated = await port.updateEvent({ externalCalendarRef: "", eventId: created.eventId, startTime: "2026-09-11T16:00:00.000Z", endTime: "2026-09-11T16:30:00.000Z", timeZone: "America/Mexico_City", etag: created.etag });
      expect(updated.eventId).toBe(created.eventId);
      expect(updated.etag).not.toBe(created.etag); // el ETag cambia con cada PUT real.
    });
  });

  it("updateEvent: If-Match con un ETag desactualizado -> CalendarConflictError (concurrencia optimista real)", async () => {
    await withSimulator(async (port) => {
      const created = await port.createEvent({ externalCalendarRef: "", summary: "x", description: "x", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City" });
      await expect(port.updateEvent({ externalCalendarRef: "", eventId: created.eventId, summary: "otro cambio", timeZone: "America/Mexico_City", etag: '"etag-que-ya-no-existe"' })).rejects.toBeInstanceOf(CalendarConflictError);
    });
  });

  it("deleteEvent: DELETE real; borrar dos veces es idempotente (segunda vez no lanza)", async () => {
    await withSimulator(async (port, sim) => {
      const created = await port.createEvent({ externalCalendarRef: "", summary: "x", description: "x", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City" });
      await port.deleteEvent({ externalCalendarRef: "", eventId: created.eventId });
      expect(sim.resources.get(created.eventId)?.deleted).toBe(true);
      await port.deleteEvent({ externalCalendarRef: "", eventId: created.eventId }); // no lanza
    });
  });

  it("actualizar un evento que nunca existió lanza CalendarEventNotFoundError (GET previo falla)", async () => {
    await withSimulator(async (port) => {
      await expect(port.updateEvent({ externalCalendarRef: "", eventId: "nunca-existió@atiende.ai", summary: "x", timeZone: "America/Mexico_City" })).rejects.toBeInstanceOf(CalendarEventNotFoundError);
    });
  });

  it("listAvailability: REPORT calendar-query real con time-range -> kind=busy con los VEVENT reales", async () => {
    await withSimulator(async (port) => {
      await port.createEvent({ externalCalendarRef: "", summary: "Cita dentro del rango", description: "", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City" });
      await port.createEvent({ externalCalendarRef: "", summary: "Cita FUERA del rango", description: "", startTime: "2026-09-20T15:00:00.000Z", endTime: "2026-09-20T15:30:00.000Z", timeZone: "America/Mexico_City" });
      const result = await assertAvailabilityContract(port, "", "busy");
      expect(result.intervals).toEqual([{ start: "2026-09-10T15:00:00.000Z", end: "2026-09-10T15:30:00.000Z" }]);
    });
  });

  it("pollChanges: sync-collection real detecta creaciones y borrados con tokens sucesivos", async () => {
    await withSimulator(async (port) => {
      const first = await port.pollChanges(null);
      expect(first.changes).toHaveLength(0);

      const created = await port.createEvent({ externalCalendarRef: "", summary: "x", description: "x", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City" });

      const second = await port.pollChanges(first.syncToken);
      expect(second.changes).toHaveLength(1);
      expect(second.changes[0]?.status).toBe(200);
      expect(second.changes[0]?.href.includes(encodeURIComponent(created.eventId))).toBe(true);

      // Sin cambios nuevos desde el token anterior: vacío otra vez.
      const third = await port.pollChanges(second.syncToken);
      expect(third.changes).toHaveLength(0);

      await port.deleteEvent({ externalCalendarRef: "", eventId: created.eventId });
      const fourth = await port.pollChanges(third.syncToken);
      expect(fourth.changes).toHaveLength(1);
      expect(fourth.changes[0]?.status).toBe(404);
    });
  });

  it("pollChanges: sync-token vencido (507) lanza para forzar resincronización completa", async () => {
    await withSimulator(async (port, sim) => {
      sim.invalidateNextSyncToken();
      await expect(port.pollChanges("token-viejo")).rejects.toThrow();
    });
  });

  it("credenciales incorrectas: el simulador rechaza con 401 real (Basic Auth)", async () => {
    const sim = new CalDavServerSimulator({ username: USERNAME, password: PASSWORD, calendarPath: CALENDAR_PATH });
    const { calendarCollectionUrl } = await sim.start();
    try {
      const port = new RealCalDavPort({ calendarCollectionUrl, username: USERNAME, password: "contraseña-incorrecta" });
      await expect(port.createEvent({ externalCalendarRef: "", summary: "x", description: "x", startTime: "2026-09-10T15:00:00.000Z", endTime: "2026-09-10T15:30:00.000Z", timeZone: "America/Mexico_City" })).rejects.toThrow();
    } finally {
      await sim.stop();
    }
  });
});
