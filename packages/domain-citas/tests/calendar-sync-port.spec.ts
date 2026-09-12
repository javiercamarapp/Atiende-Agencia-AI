import { describe, expect, it } from "vitest";
import { FakeGoogleCalendarPort } from "../src/google-calendar-port.ts";
import { assertCalendarSyncPortContract, CalendarCapabilityUnsupportedError, GoogleCalendarSyncAdapter, isRangeBookable, rangesOverlap, type AvailabilityResult } from "../src/calendar-sync-port.ts";

// ---------------------------------------------------------------------------
// GoogleCalendarSyncAdapter: Google como "una implementación entre varias" del
// contrato genérico, envolviendo el FakeGoogleCalendarPort ya probado.
// ---------------------------------------------------------------------------

describe("GoogleCalendarSyncAdapter", () => {
  it("cumple el contrato genérico completo", async () => {
    const adapter = new GoogleCalendarSyncAdapter(new FakeGoogleCalendarPort());
    await assertCalendarSyncPortContract(adapter, "calendar-de-prueba@group.calendar.google.com");
  });

  it("createEvent delega exactamente en el GoogleCalendarPort envuelto", async () => {
    const fake = new FakeGoogleCalendarPort();
    const adapter = new GoogleCalendarSyncAdapter(fake);
    const result = await adapter.createEvent({
      externalCalendarRef: "cal-1",
      summary: "Consulta - Juan Pérez",
      description: "Tel: 5512345678",
      startTime: "2026-09-10T15:00:00.000Z",
      endTime: "2026-09-10T15:30:00.000Z",
      timeZone: "America/Mexico_City",
      attendeeEmail: "juan@example.com",
    });
    const stored = fake.events.get(result.eventId);
    expect(stored).toBeDefined();
    expect(stored!.calendarId).toBe("cal-1");
    expect(stored!.summary).toBe("Consulta - Juan Pérez");
  });

  it("listAvailability declara explícitamente que no está soportado", async () => {
    const adapter = new GoogleCalendarSyncAdapter(new FakeGoogleCalendarPort());
    await expect(adapter.listAvailability({ externalCalendarRef: "cal-1", startTime: "2026-09-10T00:00:00.000Z", endTime: "2026-09-11T00:00:00.000Z" })).rejects.toBeInstanceOf(CalendarCapabilityUnsupportedError);
  });
});

// ---------------------------------------------------------------------------
// rangesOverlap / isRangeBookable: el helper genérico de conflictos, contra
// AMBAS semánticas ("busy" y "free") por separado.
// ---------------------------------------------------------------------------

describe("rangesOverlap", () => {
  it("detecta solape real", () => {
    expect(rangesOverlap("2026-09-10T15:00:00Z", "2026-09-10T15:30:00Z", "2026-09-10T15:15:00Z", "2026-09-10T15:45:00Z")).toBe(true);
  });

  it("un evento que termina justo cuando otro empieza NO se solapa (semiabierto)", () => {
    expect(rangesOverlap("2026-09-10T15:00:00Z", "2026-09-10T15:30:00Z", "2026-09-10T15:30:00Z", "2026-09-10T16:00:00Z")).toBe(false);
  });

  it("fecha ISO inválida lanza en vez de comparar silenciosamente", () => {
    expect(() => rangesOverlap("no-es-fecha", "2026-09-10T16:00:00Z", "a", "b")).toThrow();
  });
});

describe("isRangeBookable", () => {
  it("kind=busy — no reservable si se solapa con un ocupado", () => {
    const busy: AvailabilityResult = { kind: "busy", intervals: [{ start: "2026-09-10T15:00:00Z", end: "2026-09-10T16:00:00Z" }] };
    expect(isRangeBookable(busy, "2026-09-10T15:30:00Z", "2026-09-10T16:30:00Z")).toBe(false);
    expect(isRangeBookable(busy, "2026-09-10T16:00:00Z", "2026-09-10T16:30:00Z")).toBe(true);
  });

  it("kind=free — reservable SOLO si cae completo dentro de un hueco libre", () => {
    const free: AvailabilityResult = {
      kind: "free",
      intervals: [
        { start: "2026-09-10T09:00:00Z", end: "2026-09-10T10:00:00Z" },
        { start: "2026-09-10T11:00:00Z", end: "2026-09-10T12:00:00Z" },
      ],
    };
    expect(isRangeBookable(free, "2026-09-10T09:15:00Z", "2026-09-10T09:45:00Z")).toBe(true);
    expect(isRangeBookable(free, "2026-09-10T09:45:00Z", "2026-09-10T11:15:00Z")).toBe(false);
    expect(isRangeBookable(free, "2026-09-10T13:00:00Z", "2026-09-10T13:30:00Z")).toBe(false);
  });
});
